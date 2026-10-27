// The phone's line probe (m.html, "the live line, listened to and not used
// yet"): in developer mode, while the app is on screen, the phone holds the
// board's live line (GET /events) open and writes what it hears into the
// diagnostic history, and nothing else. It opens when the app is shown, closes
// on hide and on pagehide, opens again on show; it records stream-open, a beat
// for each line the board writes (revision, ms since the line's last entry,
// whether it moved) and stream-lost with why. The phone's readings are the
// same with it as without it: the reading schedule of m.html itself runs here
// both ways and makes the same readings at the same moments. Then the saved
// history goes through the server's own schema 7 validator into the dated log.
// Everything runs in node:vm on a fake clock with a fake EventSource; no
// browser, and port 8877 is never touched.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const vm = require("node:vm");
const path = require("node:path");
const { readFileSync } = require("node:fs");
const { copyFile, rm, writeFile } = require("node:fs/promises");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { fixture } = require("./phone-history-fixture.cjs");

const ROOT = path.resolve(__dirname, "..");
const HTML = readFileSync(path.join(ROOT, "m.html"), "utf8");
const flush = () => new Promise(resolve => setImmediate(resolve));

function between(text, first, last) {
  const start = text.indexOf(first), end = text.indexOf(last, start + first.length);
  assert.ok(start >= 0 && end > start, `m.html has no ${first}`);
  return text.slice(start, end);
}
// the text of one top-level function, from its first line to the brace that closes it
function functionText(head) {
  const start = HTML.indexOf(head);
  assert.notEqual(start, -1, `m.html has no ${head}`);
  return HTML.slice(start, HTML.indexOf("\n}\n", start) + 3);
}
const PROBE = between(HTML, "// ---- the live line, listened to and not used yet", "// ---- the last breath");

// a clock the test moves by hand: every timer due runs in order, promises
// settling between them
function fakeClock() {
  let now = 0, seq = 0;
  const timers = new Map();
  return {
    get now() { return now; },
    setTimeout(fn, ms = 0) { const id = ++seq; timers.set(id, { at: now + Math.max(0, Number(ms) || 0), fn, seq: id }); return id; },
    clearTimeout(id) { timers.delete(id); },
    async advance(ms) {
      const until = now + ms;
      for (;;) {
        await flush();
        let next = null;
        for (const [id, t] of timers) {
          if (t.at > until) continue;
          if (!next || t.at < next.t.at || (t.at === next.t.at && t.seq < next.t.seq)) next = { id, t };
        }
        if (!next) break;
        timers.delete(next.id);
        now = next.t.at;
        next.t.fn();
      }
      now = until;
      await flush();
    },
  };
}

// The browser's EventSource as far as the probe sees it. open() and say()
// are the board answering; fail() is the line breaking, closed meaning the
// browser gave up on it (a 401 or a 503) rather than trying again by itself
function eventSources(list) {
  return class EventSource {
    static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
    constructor(url) { this.url = url; this.readyState = 0; this.closed = false; list.push(this); }
    close() { this.closed = true; this.readyState = 2; }
    open() { this.readyState = 1; this.onopen?.({}); }
    say(line) { this.onmessage?.({ data: JSON.stringify(line) }); }
    fail(closed = false) { this.readyState = closed ? 2 : 0; this.onerror?.({}); }
  };
}

// The page around the probe: developer mode, the Mac's frame or not, whether
// the browser has an EventSource, and what the history is told (tracePhone)
function world({ developer = true, mac = false, events = true, extra = "", before = "" } = {}) {
  const clock = fakeClock();
  const sources = [], notes = [];
  const listeners = { document: {}, window: {} };
  const on = store => (name, fn) => (store[name] ||= []).push(fn);
  const document = { hidden: false, addEventListener: on(listeners.document),
    body: { classList: { contains: () => false } } };
  const context = vm.createContext({
    JSON, Number, Promise, console, document,
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms), clearTimeout: id => clock.clearTimeout(id),
    performance: { now: () => clock.now }, Date: { now: () => 1800000000000 + clock.now },
    __notes: notes, __time: () => clock.now,
  });
  context.window = context;
  context.addEventListener = on(listeners.window);
  if (events) context.EventSource = eventSources(sources);
  vm.runInContext([
    `let phoneDeveloperMode = ${developer};`,
    `const macHost = ${mac ? "{ listen() { return null; } }" : "null"};`,
    "function tracePhone(action, event, detail){ if (action === 'note') __notes.push({ event, ...detail, at: __time() }); }",
    before, PROBE, extra,
    "globalThis.__probe = lineProbe;",
    "globalThis.__developer = value => { phoneDeveloperMode = value; lineProbe.check(); };",
  ].join("\n"), context, { filename: "m.html line probe" });
  const fire = (store, name, value = {}) => { for (const fn of listeners[store][name] || []) fn(value); };
  return {
    clock, sources, notes, context,
    get line() { return sources.at(-1); },
    open: () => sources.filter(s => !s.closed),
    hide() { document.hidden = true; fire("document", "visibilitychange"); },
    show() { document.hidden = false; fire("document", "visibilitychange"); },
    pagehide() { fire("window", "pagehide"); },
    pageshow(persisted = true) { fire("window", "pageshow", { persisted }); },
    developer(value) { context.__developer(value); },
    words: () => notes.map(n => n.event === "beat" ? "beat" : n.lifecycle + (n.why ? ":" + n.why : "")),
  };
}

test("the probe names nothing the phone reads, draws or sends", () => {
  // what the phone reads and draws is the reading code's; the probe may only
  // open the line and tell the history
  for (const name of ["poll(", "schedulePoll", "readBoard", "resume(", "apply(", "render", "lastState",
                      "lastRev", "fetch(", "pollTimer", "pollGap", "ops", "els[", "innerHTML", "classList"])
    assert.equal(PROBE.includes(name), false, `the probe touches ${name}`);
  assert.equal((PROBE.match(/new EventSource\(/g) || []).length, 1);
  assert.match(PROBE, /new EventSource\("\/events"\)/);
  // developer mode switched tells the probe, after the history was switched
  assert.match(HTML, /tracePhone\("setEnabled", phoneDeveloperMode\);[\s\S]{0,400}?lineProbe\.check\(\);\n  if \(!phoneDeveloperMode\) \{/);
});

test("the line opens when the app is shown, closes on hide and pagehide, and opens again on show", async () => {
  const w = world();
  assert.equal(w.sources.length, 1, "the probe did not open the line on load");
  assert.equal(w.line.url, "/events");
  await w.clock.advance(120); w.line.open();
  await w.clock.advance(5); w.line.say({ rev: 5000, quiet: "q1" });
  await w.clock.advance(15000); w.line.say({ rev: 5000, quiet: "q1" });
  await w.clock.advance(4000); w.hide();
  assert.equal(w.sources[0].closed, true, "the line stayed open while the app was put away");
  await w.clock.advance(60000);
  assert.equal(w.sources.length, 1, "a line was asked for while the app was away");
  w.show();
  assert.equal(w.sources.length, 2, "showing the app did not open the line again");
  await w.clock.advance(80); w.line.open();
  w.line.say({ rev: 5001, quiet: "q1" });
  await w.clock.advance(2000); w.pagehide();
  assert.equal(w.sources[1].closed, true, "pagehide left the line open");
  w.pageshow(true);
  assert.equal(w.sources.length, 3, "a page back from the back and forward cache did not open the line");
  w.pageshow(false);
  assert.equal(w.sources.length, 3, "a first pageshow opened a second line");
  assert.deepEqual(w.words(), ["stream-open", "beat", "beat", "stream-lost:hidden",
    "stream-open", "beat", "stream-lost:pagehide"]);
  const [open, first, second, hidden, again] = w.notes;
  assert.deepEqual([open.at, open.ms], [120, 120], "stream-open does not say when, or how long the opening took");
  assert.deepEqual([first.rev, first.ms, first.changed], [5000, 5, false]);
  assert.deepEqual([second.at, second.rev, second.ms, second.changed], [15125, 5000, 15000, false]);
  assert.deepEqual([hidden.at, hidden.ms], [19125, 4000]);
  assert.deepEqual([again.at, again.ms], [79205, 80]);
  assert.equal(w.notes[5].rev, 5001);
  assert.equal(w.notes[5].changed, false, "a new line compared its first line with the old line's");
});

test("each line says its revision, the time since the line's last entry, and whether it moved", async () => {
  const w = world();
  w.line.open();
  w.line.say({ rev: 7, quiet: "a" });
  await w.clock.advance(3000); w.line.say({ rev: 8, quiet: "a" });     // a save rang
  await w.clock.advance(1000); w.line.say({ rev: 8, quiet: "b" });     // the mark moved
  await w.clock.advance(15000); w.line.say({ rev: 8, quiet: "b" });    // the repeat
  w.line.onmessage({ data: "not a line" });
  const beats = w.notes.filter(n => n.event === "beat");
  assert.deepEqual(beats.map(b => [b.rev, b.ms, b.changed]), [[7, 0, false], [8, 3000, true], [8, 1000, true], [8, 15000, false]]);
});

test("a line that breaks is lost with error and opened again by the browser; one refused is asked for again after 30 s", async () => {
  const w = world();
  w.line.open(); w.line.say({ rev: 1, quiet: "q" });
  await w.clock.advance(10000);
  w.line.fail();                         // the board's 10 minute end, a restart, a network drop
  assert.equal(w.sources.length, 1, "the probe made a line of its own beside the browser's retry");
  assert.equal(w.line.closed, false, "the probe closed a line the browser was opening again");
  w.line.fail();                         // the retry failing again says nothing more
  await w.clock.advance(3000); w.line.open(); w.line.say({ rev: 2, quiet: "q" });
  assert.deepEqual(w.words(), ["stream-open", "beat", "stream-lost:error", "stream-open", "beat"]);
  assert.equal(w.notes[3].ms, 3000, "the reopening does not say how long it took");
  assert.equal(w.notes[4].changed, true, "the browser's own reopen is the same line, compared with what it said");

  await w.clock.advance(1000);
  w.line.fail(true);                     // a 401 or a 503: the browser gives up
  assert.equal(w.line.closed, true);
  assert.equal(w.words().at(-1), "stream-lost:refused");
  await w.clock.advance(29999);
  assert.equal(w.sources.length, 1, "a refused line was asked for again before 30 s");
  await w.clock.advance(1);
  assert.equal(w.sources.length, 2, "a refused line was not asked for again after 30 s");
  // refused at once, never open: still said
  w.line.fail(true);
  assert.equal(w.words().at(-1), "stream-lost:refused");
  // put away while waiting for the 30 s: no line until it is back
  w.hide();
  await w.clock.advance(60000);
  assert.equal(w.sources.length, 2);
  w.show();
  assert.equal(w.sources.length, 3);
});

test("40 s with nothing on the line is a dead line: it is closed and asked for again at once", async () => {
  const w = world();
  w.line.open(); w.line.say({ rev: 1, quiet: "q" });
  await w.clock.advance(15000); w.line.say({ rev: 1, quiet: "q" });
  await w.clock.advance(39999);
  assert.equal(w.sources.length, 1, "a line was called dead before 40 s");
  await w.clock.advance(1);
  assert.equal(w.sources[0].closed, true, "a dead line was left open");
  assert.equal(w.sources.length, 2, "a dead line was not asked for again");
  const dead = w.notes.at(-1);
  assert.deepEqual([dead.lifecycle, dead.why, dead.ms], ["stream-lost", "dead", 40000]);
  // a line that never opens at all is dead after 40 s too
  await w.clock.advance(40000);
  assert.equal(w.sources.length, 3);
  assert.deepEqual(w.words().slice(-2), ["stream-lost:dead", "stream-lost:dead"]);
  // and a page put away has no dead timer running
  w.hide();
  await w.clock.advance(120000);
  assert.equal(w.sources.length, 3);
});

test("no line in the Mac's narrow view, outside developer mode, or with no EventSource; switching developer mode opens and closes it", async () => {
  assert.equal(world({ mac: true }).sources.length, 0, "the narrow view opened a line of its own");
  const off = world({ developer: false });
  assert.equal(off.sources.length, 0, "a phone out of developer mode opened the line");
  off.hide(); off.show(); off.pageshow(true);
  assert.equal(off.sources.length, 0);
  off.developer(true);
  assert.equal(off.sources.length, 1, "turning developer mode on did not open the line");
  off.line.open();
  off.developer(false);
  assert.equal(off.sources[0].closed, true, "turning developer mode off left the line open");
  assert.deepEqual(off.words(), ["stream-open"], "turning developer mode off wrote a loss into a history being cleared");
  await off.clock.advance(120000);
  assert.equal(off.sources.length, 1);
  const none = world({ events: false });
  none.hide(); none.show();
  assert.equal(none.notes.length, 0);
});

// m.html's own reading schedule, as the page runs it, with the probe beside it
// or not: readBoard is the one stand-in, and it counts
function readingPage({ developer }) {
  const before = [
    "const POLL_MS = 1200;",
    "let pollFails = 0, ops = [];",
    "const cardsMoving = () => false, listMoving = () => false, wakeOps = () => {}, linkOpened = () => {}, linkTouched = () => {};",
    "const downCount = { now(){}, start(){}, stop(){} };",
    "globalThis.__reads = [];",
    "function readBoard(){ __reads.push(__time()); return new Promise(resolve => setTimeout(resolve, 80)); }",
    between(HTML, "let pollAgain = false, pollTimer = null, pollGap = POLL_MS;", "\n"),
    between(HTML, "let pollRings = null;", "\n// a timed reading that falls due"),
    "const RUN_WAIT_MS = 250;",
    functionText("function schedulePoll(ms){"),
    "let pollRun = null;",
    functionText("function poll(){"),
    functionText("function resume(){"),
    "poll();",
    between(HTML, 'document.addEventListener("visibilitychange", () => {\n  if (document.hidden){ clearTimeout(pollTimer)',
      "\n// ---- the live line, listened to and not used yet"),
  ].join("\n");
  const w = world({ developer, before });
  // the board on the other end: open at once, a ring every 2 s, the repeat every 15 s
  let rev = 100;
  const serve = line => {
    w.clock.setTimeout(() => { if (!line.closed) { line.open(); line.say({ rev, quiet: "q" }); } }, 30);
    const ring = () => { if (line.closed) return; line.say({ rev: ++rev, quiet: "q" }); w.clock.setTimeout(ring, 2000); };
    const beat = () => { if (line.closed) return; line.say({ rev, quiet: "q" }); w.clock.setTimeout(beat, 15000); };
    w.clock.setTimeout(ring, 2000); w.clock.setTimeout(beat, 15000);
  };
  let served = 0;
  w.serve = () => { while (served < w.sources.length) serve(w.sources[served++]); };
  return w;
}

test("the phone makes the same readings at the same moments with the probe as without it", async () => {
  const runs = [];
  for (const developer of [true, false]) {
    const w = readingPage({ developer });
    const step = async ms => { for (let t = 0; t < ms; t += 10) { w.serve(); await w.clock.advance(10); } };
    await step(60000);                       // a minute on screen
    const minute = w.context.__reads.length;
    w.hide(); await step(10000);             // put away
    w.show(); await step(30000);             // and back
    runs.push({ developer, minute, reads: [...w.context.__reads], lines: w.sources.length, notes: w.notes.length });
  }
  const [probe, plain] = runs;
  assert.ok(probe.lines >= 2 && probe.notes > 30, "the probe was not running in the first run");
  assert.equal(plain.lines, 0, "the probe ran in the run without it");
  assert.ok(plain.minute >= 45, `the reading schedule made ${plain.minute} readings in a minute`);
  assert.equal(probe.minute, plain.minute, "a minute on screen made another number of /m/state readings with the probe");
  assert.deepEqual(probe.reads, plain.reads, "the readings moved with the probe");
});

// ---- the history the probe fills, through the server's own validator ------------------

function savedHistory() {
  const f = fixture(); f.history.capability(7);
  f.history.identity("phone-diag-test-7"); f.history.worker("facilitator-m-7");
  f.now(1000); f.history.note("lifecycle", { lifecycle: "stream-open", ms: 60 });
  for (let i = 1; i <= 40; i++) { f.now(1000 + 15000 * i); f.history.note("beat", { rev: 5000, ms: 15000, changed: false }); }
  f.now(601500); f.history.note("lifecycle", { lifecycle: "stream-lost", why: "error", ms: 500 });
  f.now(604600); f.history.note("lifecycle", { lifecycle: "stream-open", ms: 3100 });
  f.now(604610); f.history.note("beat", { rev: 5001, ms: 10, changed: true });
  f.now(605000); f.history.note("lifecycle", { lifecycle: "hidden" });
  return f;
}

test("ten minutes of the line save whole as schema 7, and the server writes them to the dated log", async () => {
  const f = savedHistory();
  f.now(610000);
  const pending = f.history.mark("settings", { box: "m12" });
  f.now(630000); await f.run();
  assert.equal((await pending).status, "saved");
  assert.equal(f.calls.length, 1);
  const report = f.calls[0].reports[0];
  assert.equal(report.v, 7);
  const stream = report.events.filter(e => e.event === "beat" || /^stream-/.test(e.lifecycle || ""));
  assert.equal(stream.length, 44);
  assert.deepEqual(stream[0], { lifecycle: "stream-open", ms: 60, event: "lifecycle", visible: true, online: true,
    resume: 0, at: -609000 });
  assert.ok(report.events.filter(e => e.at < -120000).every(e => stream.includes(e)));

  const { appFolder, copyBridgeFiles } = require("./fixture-auth.cjs");
  const dir = appFolder("facilitator-line-probe-");
  try {
    await copyFile(path.join(ROOT, "server.py"), path.join(dir, "server.py"));
    copyBridgeFiles(dir);
    await writeFile(path.join(dir, "batch.json"), JSON.stringify(f.calls[0]));
    const { stdout } = await promisify(execFile)(process.env.FACILITATOR_TEST_PYTHON || "python3", ["-c", `
import copy, json
from pathlib import Path
import server as s
batch = json.loads(Path("batch.json").read_text())
r = batch["reports"][0]
assert s.INCIDENT_SCHEMA == 7
assert s._incident_valid("phone", r)
assert s._post_clientlog(s.Query(), json.dumps(batch).encode()) == (200, {"ok": True, "written": 1, "dropped": 0})
lines = [json.loads(line) for p in s.LOG_DIR.glob("client-*.jsonl") for line in p.read_text().splitlines()]
assert len(lines) == 1 and lines[0]["v"] == 7 and lines[0]["events"] == r["events"]
def changed(fn):
    bad = copy.deepcopy(r); fn(bad); return bad
first = next(i for i, e in enumerate(r["events"]) if e["event"] == "beat")
lost = next(i for i, e in enumerate(r["events"]) if e.get("lifecycle") == "stream-lost")
hidden = next(i for i, e in enumerate(r["events"]) if e.get("lifecycle") == "hidden")
refused = [
    # no older schema has a name for the line
    changed(lambda b: b.update(v=6)),
    # only the line's own entries reach past 120 seconds
    changed(lambda b: b["events"].insert(0, {"event": "lifecycle", "lifecycle": "hidden", "at": -500000,
                                             "visible": True, "online": True, "resume": 0})),
    # and no further than 15 minutes
    changed(lambda b: b["events"].insert(0, {"event": "beat", "rev": 1, "at": -900001,
                                             "visible": True, "online": True, "resume": 0})),
    # a beat carries its revision, its gap and whether it moved, and nothing else
    changed(lambda b: b["events"][first].update(box="m12")),
    changed(lambda b: b["events"][first].update(changed="yes")),
    changed(lambda b: b["events"][first].update(rev=-1)),
    # why is one of five words, and only on a lost line
    changed(lambda b: b["events"][lost].update(why="private words")),
    changed(lambda b: b["events"][hidden].update(why="error")),
    changed(lambda b: b["events"][lost].update(lifecycle="stream-gone")),
]
for bad in refused:
    assert not s._incident_valid("phone", bad), bad
# the same line words under schema 6 are refused, so a v6 board never stores them
older = copy.deepcopy(r); older["v"] = 6
older["events"] = [e for e in older["events"] if e["at"] >= -120000]
assert not s._incident_valid("phone", older)
older["events"] = [e for e in older["events"] if e["event"] != "beat" and not e.get("lifecycle", "").startswith("stream-")]
assert s._incident_valid("phone", older)
print("schema 7 line history written; older schemas and stray fields refused")
`], { cwd: dir, env: { ...process.env, FACILITATOR_LOG_DIR: path.join(dir, "logs") } });
    assert.match(stdout, /refused/);
  } finally { await rm(path.dirname(dir), { recursive: true, force: true }); }
});
