// The live line's report (m.html's line probe and card-report.js lineReport):
// in developer mode, every 5 minutes while the app is on screen and once more
// when it is put away, the phone sends the board one short linereport saying
// how many lines came, how many were the board's 15 second repeats, the
// longest silence between two lines, each one over 20 s, and each open and
// loss with why. Outside developer mode nothing is counted or sent. A send
// that fails is dropped; the next report says how many went missing. Then the
// report goes through the server's own validator into the dated client log.
// The real card-report.js and the real probe run together in node:vm on one
// fake clock with a fake EventSource and a fake board; no browser, and port
// 8877 is never touched.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const vm = require("node:vm");
const path = require("node:path");
const { readFileSync } = require("node:fs");
const { copyFile, rm, writeFile } = require("node:fs/promises");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const ROOT = path.resolve(__dirname, "..");
const HTML = readFileSync(path.join(ROOT, "m.html"), "utf8");
const REPORTER = readFileSync(path.join(ROOT, "card-report.js"), "utf8");
const flush = () => new Promise(resolve => setImmediate(resolve));
const EPOCH = 1800000000000;

function between(text, first, last) {
  const start = text.indexOf(first), end = text.indexOf(last, start + first.length);
  assert.ok(start >= 0 && end > start, `m.html has no ${first}`);
  return text.slice(start, end);
}
const PROBE = between(HTML, "// ---- the live line, listened to and not used yet", "// ---- the last breath");
const TRACE = between(HTML, "function tracePhone(action, ...args){", "\n}\n") + "\n}\n";

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
    async to(at) { await this.advance(at - now); },
  };
}

// The browser's EventSource as the probe sees it; a new one is handed to the board
function eventSources(list, made) {
  return class EventSource {
    static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
    constructor(url) { this.url = url; this.readyState = 0; this.closed = false; list.push(this); made(this); }
    close() { this.closed = true; this.readyState = 2; }
    open() { this.readyState = 1; this.onopen?.({}); }
    say(line) { this.onmessage?.({ data: JSON.stringify(line) }); }
    fail(closed = false) { this.readyState = closed ? 2 : 0; this.onerror?.({}); }
  };
}

// The phone page: card-report.js started as m.html starts it, schema 7 offered
// by the board, then m.html's own tracePhone and line probe. log holds, in
// order, every entry the probe gave the history and every report sent.
function phone({ developer = true, mac = false } = {}) {
  const clock = fakeClock();
  const sources = [], log = [], posts = [];
  const listeners = { document: {}, window: {} };
  const on = store => (name, fn) => (store[name] ||= []).push(fn);
  const fire = (store, name, value = {}) => { for (const fn of listeners[store][name] || []) fn(value); };
  const document = { hidden: false, addEventListener: on(listeners.document),
    body: { classList: { contains: () => false, toggle() {} } } };
  const navigator = { onLine: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1",
    maxTouchPoints: 5, beacon: true,
    sendBeacon(url, blob) { log.push({ sent: "beacon", url, blob, time: clock.now }); return navigator.beacon; } };
  let answer = "saved";
  const context = vm.createContext({
    JSON, Number, Promise, Blob, URL, AbortController, console, document, navigator,
    location: { href: "https://phone.invalid/m" },
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms), clearTimeout: id => clock.clearTimeout(id),
    setInterval: () => 0, requestAnimationFrame: () => 0,
    performance: { now: () => clock.now }, Date: { now: () => EPOCH + clock.now },
    fetch: async (url, init = {}) => {
      if (url !== "/clientlog") return { ok: true };
      const body = JSON.parse(init.body);
      posts.push(body);
      log.push({ sent: "fetch", body, time: clock.now });
      if (answer === "throw") throw new Error("the board could not be reached");
      if (answer === 503 || answer === 400) return { ok: false, status: answer, json: async () => ({ error: "no" }) };
      const stored = answer === "saved";
      return { ok: true, status: 200, json: async () => ({ ok: true, written: stored ? 1 : 0, dropped: stored ? 0 : 1 }) };
    },
  });
  context.window = context;
  context.addEventListener = on(listeners.window);
  // the board on the other end of each line: open 30 ms after asking with its
  // first line at once, a repeat 15 s after whatever it last wrote, every save
  // rung at once. A muted line says nothing more; a dropped one breaks and the
  // browser opens it again by itself 3 s later
  const board = { rev: 100, quiet: "q" };
  const say = line => {
    line.say({ rev: board.rev, quiet: board.quiet });
    clock.clearTimeout(line.next);
    line.next = clock.setTimeout(() => { if (!line.closed && line.readyState === 1 && !line.mute) say(line); }, 15000);
  };
  // a deaf board never answers a line at all
  const serve = line => clock.setTimeout(() => { if (!line.closed && !board.deaf) { line.open(); say(line); } }, 30);
  board.ring = () => { board.rev++; for (const line of sources) if (!line.closed && line.readyState === 1 && !line.mute) say(line); };
  board.drop = line => {
    line.fail(); clock.clearTimeout(line.next);
    clock.setTimeout(() => { if (!line.closed) { line.open(); say(line); } }, 3000);
  };
  context.EventSource = eventSources(sources, serve);
  vm.runInContext(REPORTER, context, { filename: "card-report.js" });
  context.startReporter("phone", { phoneHistory: developer });
  context.phoneHistory.capability(7);
  context.phoneHistory.identity("phone-diag-test-7");
  // what the probe tells the history, as it tells it
  const note = context.phoneHistory.note;
  context.phoneHistory.note = (event, detail) => { log.push({ event, ...detail, time: clock.now }); return note(event, detail); };
  vm.runInContext([
    `let phoneDeveloperMode = ${developer};`,
    `const macHost = ${mac ? "{ listen() { return null; } }" : "null"};`,
    TRACE, PROBE,
    "globalThis.__probe = lineProbe;",
    // the developer switch, in m.html's order (asserted below)
    "globalThis.__developer = value => { phoneDeveloperMode = value; tracePhone('setEnabled', value); lineProbe.check(); };",
  ].join("\n"), context, { filename: "m.html line probe" });
  return {
    clock, sources, board, posts, log, context, navigator,
    get line() { return sources.at(-1); },
    answer(value) { answer = value; },
    hide() { document.hidden = true; fire("document", "visibilitychange"); },
    show() { document.hidden = false; fire("document", "visibilitychange"); },
    pagehide() { fire("window", "pagehide"); },
    pageshow(persisted = true) { fire("window", "pageshow", { persisted }); },
    developer(value) { context.__developer(value); },
    sent: () => log.filter(e => e.sent),
    // every line report sent so far, in order, with when and how
    async reports() {
      const out = [];
      for (const e of log.filter(e => e.sent)) {
        const batch = e.sent === "beacon" ? JSON.parse(await e.blob.text()) : e.body;
        out.push({ via: e.sent, time: e.time, batch, ...batch.reports[0] });
      }
      return out;
    },
  };
}

test("the developer switch tells the history before the probe, as the test's switch does", () => {
  assert.match(HTML, /phoneDeveloperMode = !phoneDeveloperMode;\n  tracePhone\("setEnabled", phoneDeveloperMode\);[\s\S]{0,400}?lineProbe\.check\(\);/);
  assert.match(PROBE, /tracePhone\("lineReport", "period"\)/);
  assert.match(PROBE, /LINE_REPORT_MS = 300000/);
});

test("outside developer mode nothing is counted or sent, whatever the line or the app does", async () => {
  const w = phone({ developer: false });
  await w.clock.advance(20 * 60000);
  w.hide(); await w.clock.advance(60000); w.show(); w.pagehide(); w.pageshow(true);
  await w.clock.advance(20 * 60000);
  assert.equal(w.sources.length, 0, "the line was opened outside developer mode");
  // even asked directly, a history that is off counts and sends nothing
  w.context.phoneHistory.note("lifecycle", { lifecycle: "stream-open", ms: 30 });
  w.context.phoneHistory.note("beat", { rev: 1, ms: 0, changed: false });
  for (const why of ["period", "hidden", "pagehide"]) assert.equal(w.context.phoneHistory.lineReport(why), false);
  w.hide();
  assert.deepEqual(w.sent(), [], "a phone out of developer mode sent a line report");
  assert.deepEqual(w.posts, []);

  // switched on and off again: nothing on the switch, nothing after it
  w.show(); w.developer(true);
  await w.clock.advance(120000);
  w.developer(false);
  await w.clock.advance(20 * 60000);
  w.hide(); w.pagehide();
  assert.deepEqual(w.sent(), [], "switching developer mode off sent or kept a report");

  // and the Mac's narrow view, in developer mode, opens no line and reports none
  const mac = phone({ mac: true });
  await mac.clock.advance(20 * 60000);
  mac.hide(); mac.pagehide();
  assert.equal(mac.sources.length, 0);
  assert.deepEqual(mac.sent(), []);
});

test("in developer mode a report goes every 5 minutes on screen and once when the app is put away", async () => {
  const w = phone();
  await w.clock.to(16 * 60000);
  w.hide();                                  // put away after 16 minutes
  w.pagehide();                              // and the pagehide after it says nothing more
  await w.clock.advance(10 * 60000);         // 10 minutes away
  w.show();
  await w.clock.advance(7 * 60000);
  w.pagehide();                              // a pagehide with no hide before it
  w.hide();
  await w.clock.advance(60000);
  const reports = await w.reports();
  assert.deepEqual(reports.map(r => [r.time, r.via, r.reason, r.n]), [
    [300000, "fetch", "period", 1], [600000, "fetch", "period", 2], [900000, "fetch", "period", 3],
    [960000, "beacon", "hidden", 4],
    [1860000, "fetch", "period", 5],
    [1980000, "beacon", "pagehide", 6],
  ]);
  // each covers its own stretch on screen and nothing of the time away
  assert.deepEqual(reports.map(r => [r.start - EPOCH, r.ms]), [
    [0, 300000], [300000, 300000], [600000, 300000], [900000, 60000],
    [1560000, 300000], [1860000, 120000],
  ]);
  for (const r of reports) {
    assert.equal(r.kind, "linereport"); assert.equal(r.v, 7);
    assert.equal(r.build, "phone-diag-test-7"); assert.equal(r.unsent, 0);
    assert.equal(r.net, "unknown", "Safari on the iPhone has no network type and none was made up");
    assert.equal(r.batch.page, "phone"); assert.equal(r.batch.client, "phone");
    assert.match(r.batch.window, /^[a-f0-9]{16}$/);
    assert.equal(r.batch.reports.length, 1);
    assert.ok(Buffer.byteLength(JSON.stringify(r.batch)) < 1200, "a quiet stretch's report is not small");
  }
  // a quiet board: the first line of each opening and then a repeat every 15 s
  assert.deepEqual(reports.map(r => [r.lines, r.beats, r.gapMax]), [
    [20, 19, 15000], [20, 20, 15000], [20, 20, 15000], [4, 4, 15000], [20, 19, 15000], [8, 8, 15000],
  ]);
  assert.ok(reports.every(r => r.gaps.length === 0 && r.omitted === 0));
  assert.deepEqual(reports[3].stream.map(e => [e.event, e.why, e.at]), [["stream-lost", "hidden", 60000]]);
  assert.deepEqual(reports[4].stream.map(e => [e.event, e.at, e.ms]), [["stream-open", 30, 30]]);
  // back on screen, reports start again; the network type, where the page can know it
  w.navigator.connection = { type: "wifi" };
  w.show();
  await w.clock.advance(5 * 60000);
  const back = (await w.reports()).at(-1);
  assert.deepEqual([back.n, back.reason, back.net, back.ms], [7, "period", "wifi", 300000]);
});

// What the probe told the history, summed up independently: each report's
// share of the entries is everything noted since the report before it. A
// line's gap runs from the line before it, or from asking for the line when
// none has come since the app was shown
function expected(log) {
  const out = [];
  let share = [], since = null, previous = null;
  for (const e of log) {
    if (e.sent) { out.push(share); share = []; continue; }
    if (since === null) since = e.time - e.ms;
    const item = { ...e };
    if (e.event === "beat") {
      item.gap = e.time - since; since = e.time;
      item.repeat = !e.changed && previous?.event === "beat";
    }
    if (e.why === "hidden" || e.why === "pagehide") since = null;
    previous = e;
    share.push(item);
  }
  return out;
}

test("each report's numbers are the probe's own entries: rings, a break, a dead line and a refusal", async () => {
  const w = phone();
  await w.clock.to(20000); w.board.ring();                 // a save rings the line
  await w.clock.to(100000); w.board.drop(w.line);          // the board ends the line; the browser reopens it
  await w.clock.to(150000); w.line.mute = true;            // the line goes quiet: dead after 40 s
  await w.clock.to(300000);                                // the first report
  await w.clock.to(330000); w.board.ring(); w.board.ring();
  await w.clock.to(400000); w.line.fail(true);             // refused: asked for again 30 s later
  await w.clock.to(470000); w.hide();
  const reports = await w.reports();
  assert.deepEqual(reports.map(r => r.reason), ["period", "hidden"]);
  const shares = expected(w.log);
  assert.equal(shares.length, 2);
  for (const [i, r] of reports.entries()) {
    const share = shares[i], from = r.start - EPOCH;
    const beats = share.filter(e => e.event === "beat");
    assert.equal(r.lines, beats.length, `report ${i + 1}: lines`);
    assert.equal(r.beats, beats.filter(e => e.repeat).length, `report ${i + 1}: beats`);
    assert.equal(r.gapMax, Math.max(0, ...beats.map(e => e.gap)), `report ${i + 1}: gapMax`);
    assert.deepEqual(r.gaps, beats.filter(e => e.gap > 20000).map(e => ({ at: e.time - from, ms: e.gap })),
      `report ${i + 1}: gaps`);
    assert.deepEqual(r.stream, share.filter(e => e.event === "lifecycle").map(e => ({
      at: e.time - from, event: e.lifecycle, ms: e.ms, online: true, ...(e.why ? { why: e.why } : {}) })),
      `report ${i + 1}: opens and losses`);
  }
  // and the same, as numbers a reader of the log sees
  const [first, second] = reports;
  assert.deepEqual([first.lines, first.beats, first.gapMax], [20, 16, 40030]);
  assert.deepEqual(first.gaps, [{ at: 188030, ms: 40030 }]);
  assert.deepEqual(first.stream.map(e => [e.at, e.event, e.why || "", e.ms]), [
    [30, "stream-open", "", 30], [100000, "stream-lost", "error", 5000], [103000, "stream-open", "", 3000],
    [188000, "stream-lost", "dead", 40000], [188030, "stream-open", "", 30]]);
  assert.deepEqual(second.stream.map(e => [e.at, e.event, e.why || "", e.ms]), [
    [100000, "stream-lost", "refused", 10000], [130030, "stream-open", "", 30], [170000, "stream-lost", "hidden", 9970]]);
  assert.deepEqual(second.gaps, [{ at: 130030, ms: 40030 }]);
});

test("a line that never reaches the phone is reported as it is: no lines, and a dead line every 40 s", async () => {
  const w = phone();
  w.board.deaf = true;
  await w.clock.to(300000);
  const [report] = await w.reports();
  assert.deepEqual([report.reason, report.lines, report.beats, report.gapMax, report.gaps], ["period", 0, 0, 0, []]);
  assert.deepEqual(report.stream.map(e => [e.at, e.event, e.why, e.ms]),
    [1, 2, 3, 4, 5, 6, 7].map(i => [40000 * i, "stream-lost", "dead", 40000]));
  // and a stretch in which nothing at all was said is still sent, empty
  w.context.phoneHistory.lineReport("period");
  await w.clock.advance(0);
  const empty = (await w.reports()).at(-1);
  assert.deepEqual([empty.n, empty.ms, empty.lines, empty.stream, empty.gaps, empty.omitted], [2, 0, 0, [], [], 0]);
});

test("a send that fails is dropped and the next report says so; nothing is kept to send again", async () => {
  const w = phone();
  w.answer("throw");
  await w.clock.to(300000);                  // the board cannot be reached
  w.answer(503);
  await w.clock.to(600000);                  // the board refuses
  w.answer("dropped");
  await w.clock.to(900000);                  // the board took it and wrote nothing
  w.answer("saved");
  w.navigator.beacon = false;
  w.hide();                                  // the beacon is not taken
  w.navigator.beacon = true;
  w.show();
  w.navigator.onLine = false;
  await w.clock.advance(300000);             // offline: not sent at all
  w.navigator.onLine = true;
  await w.clock.advance(300000);
  await w.clock.advance(300000);
  const reports = await w.reports();
  assert.deepEqual(reports.map(r => [r.via, r.n, r.unsent]), [
    ["fetch", 1, 0], ["fetch", 2, 1], ["fetch", 3, 2], ["beacon", 4, 3], ["fetch", 6, 5], ["fetch", 7, 5]]);
  // one send per report, never a second try of one that failed
  assert.equal(w.posts.length, 5);
  // a failed report's stretch is not added to the next one
  assert.deepEqual(reports.map(r => r.ms), [300000, 300000, 300000, 0, 300000, 300000]);
  // a board that has not offered schema 7 is not sent one
  w.context.phoneHistory.capability(6);
  await w.clock.advance(300000);
  w.context.phoneHistory.capability(7);
  await w.clock.advance(300000);
  assert.deepEqual((await w.reports()).slice(-1).map(r => [r.n, r.unsent]), [[9, 6]]);
  assert.equal(w.posts.length, 6);
});

test("the server writes a line report to the dated client log and refuses an older schema or any other field", async () => {
  const w = phone();
  await w.clock.to(20000); w.board.ring();
  await w.clock.to(150000); w.line.mute = true;
  await w.clock.to(300000);
  await w.clock.to(310000); w.hide();
  const reports = await w.reports();
  assert.equal(reports.length, 2);
  const { appFolder, copyBridgeFiles } = require("./fixture-auth.cjs");
  const dir = appFolder("facilitator-line-reports-");
  try {
    await copyFile(path.join(ROOT, "server.py"), path.join(dir, "server.py"));
    copyBridgeFiles(dir);
    await writeFile(path.join(dir, "batches.json"), JSON.stringify(reports.map(r => r.batch)));
    const { stdout } = await promisify(execFile)(process.env.FACILITATOR_TEST_PYTHON || "python3", ["-c", `
import copy, json
from pathlib import Path
import server as s
batches = json.loads(Path("batches.json").read_text())
post = lambda b: s._post_clientlog(s.Query(), json.dumps(b).encode())
for batch in batches:
    assert post(batch) == (200, {"ok": True, "written": 1, "dropped": 0}), batch
lines = [json.loads(line) for p in sorted(s.LOG_DIR.glob("client-*.jsonl")) for line in p.read_text().splitlines()]
assert len(lines) == 2, lines
for line, batch in zip(lines, batches):
    r = batch["reports"][0]
    assert line["kind"] == "linereport" and line["level"] == "info" and "box" not in line
    assert line["page"] == "phone" and line["client"] == "phone" and line["window"] == batch["window"]
    assert {k: v for k, v in line.items() if k not in ("ts", "level", "kind", "page", "client", "window")} == \\
        {k: v for k, v in r.items() if k != "kind"}, line
r = batches[0]["reports"][0]
assert r["gaps"] and r["stream"], r
def changed(fn):
    bad = copy.deepcopy(r); fn(bad); return bad
refused = [
    # only schema 7 names the line
    changed(lambda b: b.update(v=6)), changed(lambda b: b.update(v=5)), changed(lambda b: b.update(v=1)),
    changed(lambda b: b.update(v="7")), changed(lambda b: b.update(v=7.0)),
    # no field more and none fewer
    changed(lambda b: b.update(box="m12")), changed(lambda b: b.update(message="anything")),
    changed(lambda b: b.pop("net")), changed(lambda b: b.pop("omitted")),
    changed(lambda b: b["gaps"][0].update(why="dead")),
    changed(lambda b: b["stream"][0].update(rev=1)),
    changed(lambda b: b["stream"][0].update(why="error")),         # an open has no why
    changed(lambda b: b["stream"][1].pop("why")),                  # a loss has one
    # fixed words, bounded numbers, in order of time within the stretch
    changed(lambda b: b.update(reason="manual")), changed(lambda b: b.update(net="home wifi")),
    changed(lambda b: b["stream"][1].update(why="private words")),
    changed(lambda b: b["stream"][0].update(event="beat")),
    changed(lambda b: b["stream"][0].update(online="yes")),
    changed(lambda b: b["stream"][-1].update(at=b["ms"] + 1)),
    changed(lambda b: b["stream"].reverse()),
    changed(lambda b: b["gaps"][0].update(ms=20000)),              # a listed gap is over 20 s
    changed(lambda b: b["gaps"][0].update(ms=b["gapMax"] + 1)),
    changed(lambda b: b.update(beats=b["lines"] + 1)),
    changed(lambda b: b.update(n=0)), changed(lambda b: b.update(unsent=-1)),
    changed(lambda b: b.update(ms=86400001)), changed(lambda b: b.update(lines=True)),
    changed(lambda b: b.update(build="Phone Build")),
    changed(lambda b: b.update(stream=[b["stream"][0]] * 17)),     # at most 16
]
for bad in refused:
    assert not s._line_report_valid("phone", bad), bad
    assert post({**batches[0], "reports": [bad]}) == (400, {"error": "bad line report"}), bad
assert not s._line_report_valid("board", r)
assert post({**batches[0], "page": "board"}) == (400, {"error": "bad line report"})
# a refused batch stores nothing, not even its good reports
assert post({**batches[0], "reports": [r, refused[0]]})[0] == 400
lines = [line for p in s.LOG_DIR.glob("client-*.jsonl") for line in p.read_text().splitlines()]
assert len(lines) == 2
print("line reports written; older schemas and stray fields refused")
`], { cwd: dir, env: { ...process.env, FACILITATOR_LOG_DIR: path.join(dir, "logs") } });
    assert.match(stdout, /refused/);
  } finally { await rm(path.dirname(dir), { recursive: true, force: true }); }
});
