// Real scroll engine, phone hooks and recorder on a simulated clock. No browser
// or network. Optional old-source paths prove these checks catch the missing trace.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { fixture } = require("./phone-history-fixture.cjs");
const root = path.join(__dirname, "..");
const html = readFileSync(process.env.PHONE_TIMING_SOURCE || path.join(root, "m.html"), "utf8");
const logic = readFileSync(process.env.SCROLL_LOGIC_SOURCE || path.join(root, "card-logic.js"), "utf8");
const between = (text, first, last) => {
  const start = text.indexOf(first), end = text.indexOf(last, start);
  assert.ok(start >= 0 && end > start, `missing ${first}`);
  return text.slice(start, end);
};
const latest = f => f.calls.at(-1).reports[0];
function phone({ enabled = true, surface = "reply", longtasks = false, writeDelay = 0 } = {}) {
  const observers = [];
  const f = fixture("phone", { setup(c) {
    c.document.body.classList.toggle = () => {};
    c.document.visibilityState = "visible";
    c.localStorage = { getItem: () => enabled ? "on" : null };
    c.cancelAnimationFrame = () => {};
    if (longtasks) c.PerformanceObserver = class {
      static supportedEntryTypes = ["longtask"];
      constructor(fn) { this.fn = fn; this.disconnected = false; observers.push(this); }
      observe(options) { this.options = options; }
      disconnect() { this.disconnected = true; }
    };
    vm.runInContext(logic, c);
    vm.runInContext('function phoneDrawerScrollCard(){ return currentCard; }', c);
    vm.runInContext(between(html, "// Developer mode belongs", "function traceFrameOpportunity"), c);
  } });
  let top = 100, reads = 0, time = 0;
  const writes = [], view = { ownerDocument: f.document, isConnected: true, contains: () => false };
  for (const [name, get] of Object.entries({ clientHeight: () => 400, scrollHeight: () => 100000, scrollTop: () => top }))
    Object.defineProperty(view, name, { get() { reads++; return get(); },
      ...(name === "scrollTop" ? { set(value) { top = value; writes.push(value); time += writeDelay; f.now(time); } } : {}) });
  f.context.currentCard = { id: "m12", owner: "test", el: { replyview: view } };
  f.history.capability(6);
  const exec = code => vm.runInContext(code, f.context);
  return { ...f, exec, writes, observers, reads: () => reads, top: () => top,
    at(value) { time = value; f.now(value); },
    advance(ms = 16, offered) { time += ms; f.now(time); f.frame(offered ?? time); },
    start() { f.context.responseScrollKey({ target: f.document.body, repeat: false, preventDefault() {} },
      surface === "list" ? f.context.phoneDrawerScrollCard : () => f.context.currentCard); },
    stop() { f.context.responseScrollKeyUp({ key: "s", ctrlKey: true }); },
    mode(value) { exec(`phoneDeveloperMode = ${value}; tracePhone("setEnabled", phoneDeveloperMode);
      responseScrollTiming = phoneDeveloperMode ? phoneKeyboardTiming : null;`); },
    async save() { const pending = f.history.mark("shortcut"); time += 20000; f.now(time); await f.run();
      assert.equal((await pending).status, "saved"); return latest(f); },
  };
}

for (const surface of ["reply", "list"]) test(`${surface}: a real keyboard hold saves positions, clocks, frames and app jobs`, async () => {
  const f = phone({ surface }); f.at(1000); f.start(); f.advance(16);
  // Use the actual phone job wrappers. Each is allowed to return or throw, and
  // must still record its end without changing that result.
  f.exec('let drawerKeyboardUsed = false, drawerPick = null;');
  f.exec(between(html, "function drawerSliding(){", '\ndocument.addEventListener("keydown"'));
  assert.equal(f.context.syncDrawerPick(), null);
  f.exec(between(html, 'function renderTickets(state,', '\n// each button writes'));
  Object.assign(f.context, { phoneEnterAgain: null, syncSentView: () => null,
    document: f.document, paintViewTabs() {}, ticketsShown: () => false });
  f.document.getElementById = () => null;
  f.context.renderTickets({});
  f.exec(between(html, "function drawCard(el, b, state){", "\n// a card taken down"));
  f.context.replyFull = () => { throw new Error("fixture draw failure"); };
  assert.throws(() => f.context.drawCard({}, {}, {}), /fixture draw failure/);
  // The same recorder receives the synchronous state and JSON spans; ensure
  // their real hooks enclose work, and never the awaited network body.
  assert.ok(/const text = await readingText\(r, abort\);\s+const timing = phoneDeveloperMode \? tracePhone\("jobStart", "json"\)/.test(html), "JSON work is timed after the download");
  assert.ok(/if \(data\)\{\s+const timing = phoneDeveloperMode \? tracePhone\("jobStart", "board"\)/.test(html), "board handling has its own job span");
  for (const name of ["json", "board"]) { const token = f.history.jobStart(name); f.history.jobEnd(token); }
  f.advance(17, 1030); f.stop();
  const report = await f.save(), rows = report.timing.rows;
  assert.equal(report.v, 6); assert.equal(report.timing.longtasks, false);
  assert.ok(rows.every(row => row[2] === surface));
  assert.deepEqual(rows.filter(row => row[1] === "step").map(row => row[4]), f.writes);
  const step = rows.find(row => row[1] === "step");
  assert.equal(step[0], -17); assert.equal(step[3], -17); assert.equal(step[5], -17); assert.equal(step[6], -17);
  assert.ok(rows.some(row => row[1] === "frame" && row[3] === -3));
  for (const name of ["board", "json", "list", "reply", "glass"])
    assert.deepEqual(rows.filter(row => row[3] === name).map(row => row[1]), ["job-start", "job-end"]);
  assert.ok(rows.some(row => row[1] === "start")); assert.ok(rows.some(row => row[1] === "end"));
});

test("developer mode off records nothing and adds no layout reads or scroll changes", async () => {
  const on = phone(), off = phone({ enabled: false, longtasks: true });
  for (const f of [on, off]) { f.at(1000); f.start(); f.advance(); f.advance(); f.stop(); }
  assert.deepEqual(on.writes, off.writes); assert.equal(on.reads(), off.reads());
  assert.equal(off.observers.length, 0);
  assert.equal(await off.history.jobStart("board"), null);
  assert.equal((await off.history.mark("shortcut")).status, "disabled");
  off.at(22000); await off.run(); assert.equal(off.calls.length, 0);
  off.mode(true); const report = await off.save(); assert.deepEqual(report.timing.rows, []);
});

for (const gap of [99, 100, 150]) test(`a ${gap} ms step/frame gap respects the automatic threshold and shared cooldown`, async () => {
  const f = phone(); f.at(1000); f.start(); f.advance(16); f.advance(gap); f.advance(gap); f.stop();
  f.at(23000); await f.run();
  assert.equal(f.calls.length, gap < 100 ? 0 : 1);
  if (gap < 100) return;
  const report = latest(f);
  assert.equal(report.reason, "slow-ui"); assert.equal(report.events.find(e => e.event === "mark").at, 0);
  assert.ok(report.timing.rows.some(row => row[1] === "step" && row[0] === 0));
  assert.ok(report.timing.rows.some(row => row[1] === "frame" && row[0] === 0), "same-clock recovery row was lost");
  f.at(24000); f.history.noScroll("m12"); f.start(); f.advance(gap); f.stop();
  await f.run(); assert.equal(f.calls.length, 1, "another trigger bypassed the cooldown");
  f.at(33000); f.start(); f.advance(gap); f.stop(); f.at(54000); await f.run();
  assert.equal(f.calls.length, 2);
});

test("frame gaps trigger even without a new set step, and watching lasts for the whole hold", async () => {
  const f = phone(); f.at(1000);
  f.history.keyboardScroll("start", "reply");
  for (let i = 0; i < 400; i++) f.advance(16);
  assert.equal(f.calls.length, 0);
  f.advance(100); f.history.keyboardScroll("end", "reply");
  f.at(28000); await f.run();
  assert.equal(f.calls.length, 1);
  assert.ok(latest(f).timing.rows.some(row => row[1] === "frame" && row[0] === 0));
  assert.equal(latest(f).timing.rows.some(row => row[1] === "step"), false);
});

test("bounded high-rate recovery preserves the captured gap and keeps the whole batch under 12 KB", async () => {
  const f = phone(); f.at(1000); f.start(); f.advance(16);
  const job = f.history.jobStart("board"); f.at(1100); f.history.jobEnd(job); f.advance(50);
  for (let i = 0; i < 3000; i++) {
    f.advance(5);
    f.history.note("input", { action: "card", part: "touch", box: "m12" });
    const job = f.history.jobStart("glass"); f.history.jobEnd(job);
  }
  f.stop(); f.at(22000); await f.run();
  assert.equal(f.calls.length, 1);
  const report = latest(f), rows = report.timing.rows;
  assert.ok(report.timing.lost > 0); assert.ok(rows.length <= 240);
  assert.ok(rows.some(row => row[1] === "job-start" && row[3] === "board" && row[0] < 0));
  assert.ok(rows.some(row => row[1] === "step" && row[0] === 0));
  assert.ok(rows.some(row => row[0] > 0));
  assert.ok(Buffer.byteLength(JSON.stringify(report.timing)) <= 6144);
  assert.ok(Buffer.byteLength(JSON.stringify(f.calls[0])) <= 12 * 1024);
  assert.doesNotMatch(JSON.stringify(report.timing), /m12|https|key|text|title/);
});

test("reported long tasks survive late delivery after stop; off mode disconnects and discards them", async () => {
  const f = phone({ longtasks: true }); f.at(1000); f.start(); f.advance();
  const observer = f.observers[0]; assert.deepEqual(JSON.parse(JSON.stringify(observer.options)), { type: "longtask", buffered: false });
  f.stop(); const pending = f.history.mark("shortcut");
  observer.fn({ getEntries: () => [{ startTime: 1002, duration: 70, name: "private script address" },
    { startTime: 50, duration: 10 }] });
  f.at(22000); await f.run(); assert.equal((await pending).status, "saved");
  assert.deepEqual(latest(f).timing.rows.filter(row => row[1] === "longtask"), [[-14, "longtask", "reply", 70]]);
  assert.equal(latest(f).timing.longtasks, true);
  f.mode(false); assert.equal(observer.disconnected, true);
  observer.fn({ getEntries: () => [{ startTime: 1002, duration: 70 }] });
  f.mode(true); const report = await f.save(); assert.deepEqual(report.timing.rows, []);
});

test("turning off during a hold discards traces, cancels automatic collection, and leaves motion alone", async () => {
  const f = phone(); f.at(1000); f.start(); f.advance(100);
  f.mode(false); f.advance(16); f.stop(); f.at(25000); await f.run();
  assert.equal(f.calls.length, 0); assert.equal(f.writes.length, 2);
  f.mode(true); assert.deepEqual((await f.save()).timing.rows, []);
});

test("schema fallback omits timing, tells the caller, and spends the same four-attempt budget", async () => {
  const f = phone(); f.at(1000); f.start(); f.advance(); f.stop();
  f.answer((_url, _init, batch) => Promise.resolve(batch.reports[0].v > 3 ? { ok: false, status: 400 }
    : { ok: true, json: async () => ({ ok: true, written: 1, dropped: 0 }) }));
  const pending = f.history.mark("shortcut"); f.at(22000); await f.run();
  assert.equal((await pending).status, "saved-legacy");
  assert.deepEqual(f.calls.map(b => b.reports[0].v), [6, 5, 4, 3]);
  assert.equal("timing" in f.calls[1].reports[0], false);
  const limited = f.history.mark("shortcut"); f.at(43000); await f.run();
  assert.equal((await limited).status, "limited"); assert.equal(f.calls.length, 4);
});

test("page hide ends the timing run and uses the existing bounded beacon", async () => {
  const f = phone(); f.at(1000); f.start(); f.advance(100);
  f.hidden(true); f.fire("pagehide"); await f.run();
  const saved = JSON.parse(await f.beacons[0].body.text());
  assert.equal(saved.reports[0].v, 6); assert.equal(saved.reports[0].reason, "slow-ui");
  assert.ok(saved.reports[0].timing.rows.some(row => row[1] === "end"));
  assert.ok(Buffer.byteLength(JSON.stringify(saved)) <= 12 * 1024);
  assert.equal(f.calls.length, 0);
});

test("a saved keyboard trace passes the real route validator and reaches the dated log unchanged", async () => {
  const { copyFile, mkdtemp, rm, writeFile } = require("node:fs/promises");
  const { tmpdir } = require("node:os");
  const { execFile } = require("node:child_process");
  const { promisify } = require("node:util");
  const dir = await mkdtemp(path.join(tmpdir(), "facilitator-keyboard-timing-"));
  try {
    const f = phone(); f.at(1000); f.start(); f.advance(16);
    const job = f.history.jobStart("board"); f.history.jobEnd(job); f.advance(100); f.stop();
    f.at(22000); await f.run();
    assert.equal(f.calls.length, 1);
    await copyFile(process.env.PHONE_TIMING_SERVER || path.join(root, "server.py"), path.join(dir, "server.py"));
    require("./fixture-auth.cjs").copyBridgeFiles(dir);
    await writeFile(path.join(dir, "batch.json"), JSON.stringify(f.calls[0]));
    const { stdout } = await promisify(execFile)(process.env.FACILITATOR_TEST_PYTHON || "python3", ["-c", `
import copy, json
from pathlib import Path
import server as s
batch = json.loads(Path("batch.json").read_text())
r = batch["reports"][0]
assert s.INCIDENT_SCHEMA == 6
assert s._incident_valid("phone", r)
assert not s._incident_valid("board", r)
assert s._post_clientlog(s.Query(), json.dumps(batch).encode()) == (200, {"ok":True, "written":1, "dropped":0})
lines = [json.loads(line) for p in s.LOG_DIR.glob("client-*.jsonl") for line in p.read_text().splitlines()]
assert len(lines) == 1 and lines[0]["timing"] == r["timing"]
assert lines[0]["events"] == r["events"]
# Every new slot is numeric or an enum, never an arbitrary key, address or text.
rows = [[0, "start", "reply", "private"], [0, "step", "reply", 0, "private", 0, 0],
        [0, "step", "reply", 0, -1, 0, 0], [0, "step", "reply", 0, 1000001, 0, 0],
        [0, "frame", "list", float("nan")], [0, "frame", "reply", 20001],
        [0, "frame", "reply", True], [0, "job-start", "reply", "https://private.invalid"],
        [0, "longtask", "reply", 600001], [0, "unknown", "reply"],
        [0, "end", "private"]]
for row in rows:
    bad = copy.deepcopy(r); bad["timing"]["rows"] = [row]
    assert not s._incident_valid("phone", bad), row
for value in (dict(r["timing"], text="private"), dict(r["timing"], longtasks=1),
              dict(r["timing"], lost=-1), dict(r["timing"], rows=[[0,"start","reply"]] * 241),
              dict(r["timing"], rows=[[0,"step","reply",-119999.9,999999.99,-119999.9,-119999.9]] * 200),
              dict(r["timing"], rows=[[1,"start","reply"], [0,"end","reply"]])):
    assert not s._incident_valid("phone", dict(r, timing=value)), value
assert not s._incident_valid("phone", dict(r, v=5))
# The existing server incident cap is shared with ordinary manual histories.
for n in range(3):
    assert s._post_clientlog(s.Query(), json.dumps(batch).encode())[1]["written"] == 1
assert s._post_clientlog(s.Query(), json.dumps(batch).encode()) == (200, {"ok":True, "written":0, "dropped":1})
print("Timing persisted; strict privacy, size, type, schema and rate checks passed")
`], { cwd: dir, env: { ...process.env, FACILITATOR_LOG_DIR: path.join(dir, "logs") } });
    assert.match(stdout, /checks passed/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a broken long-task observer cannot interrupt a hold or a mode change", async () => {
  const f = phone();
  f.context.PerformanceObserver = class {
    static supportedEntryTypes = ["longtask"];
    observe() { throw new Error("unavailable"); }
    disconnect() {}
  };
  f.mode(false); f.mode(true); f.at(1000); f.start(); f.advance(); f.stop();
  const report = await f.save();
  assert.equal(report.timing.longtasks, false);
  assert.ok(report.timing.rows.some(row => row[1] === "step"));
});

test("step computation, set completion, offered frame and callback clocks stay distinct", async () => {
  const f = phone({ writeDelay: 2 }); f.at(1000); f.start(); f.advance(16, 1010); f.stop();
  const rows = (await f.save()).timing.rows;
  assert.deepEqual(rows.find(row => row[1] === "step"), [0, "step", "reply", -2, 101.5, -8, -2]);
  assert.deepEqual(rows.find(row => row[1] === "frame"), [0, "frame", "reply", -8]);
});

test("online and offline events during a hold keep recording its steps and jobs", async () => {
  const f = phone(); f.at(1000); f.start(); f.advance(); f.fire("offline");
  f.advance(); f.fire("online"); const job = f.history.jobStart("board"); f.history.jobEnd(job);
  f.advance(); f.stop();
  const rows = (await f.save()).timing.rows;
  assert.equal(rows.filter(row => row[1] === "step").length, 3);
  assert.equal(rows.filter(row => row[1] === "end").length, 1);
  assert.ok(rows.some(row => row[1] === "job-end" && row[3] === "board"));
});

test("a double press still reverses direction, and a broken optional recorder cannot change motion", async () => {
  const f = phone(); f.at(1000); f.start(); f.advance(); f.stop();
  f.advance(30); f.start(); f.advance(); f.stop();
  const rows = (await f.save()).timing.rows;
  assert.deepEqual(rows.filter(row => row[1] === "step").map(row => row[4]), [102.4, 100]);
  f.exec('responseScrollTiming = () => { throw new Error("broken recorder"); };');
  f.at(25000); f.start(); f.advance(); f.stop(); assert.equal(f.top(), 102.4);
});

test("an older advertised schema keeps timing locally and reports any omitted evidence", async () => {
  const f = phone(); f.history.capability(5); f.at(1000); f.start(); f.advance(); f.stop();
  let pending = f.history.mark("shortcut"); f.at(22000); await f.run();
  assert.equal((await pending).status, "saved-legacy"); assert.equal(latest(f).v, 5);
  assert.equal("timing" in latest(f), false);
  f.history.capability(6); pending = f.history.mark("shortcut"); f.at(43000); await f.run();
  assert.equal((await pending).status, "saved");
  assert.ok(latest(f).timing.rows.some(row => row[1] === "step"));
});
