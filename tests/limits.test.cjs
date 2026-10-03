// The limits box's data: limits.py (what a window is called, when a window
// shows 0, which tools show, how Codex is asked and how seldom, what happens
// when it hangs or fails) and GET /limits on a fixture board of its own. Every
// number is invented. The Codex here is a small fake on a PATH of its own, so
// no real codex is started, and HOME points into the fixture, so no real log is
// read.
const assert = require("node:assert/strict");
const { after, test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ROOT, installCodex, codexReply, windowOf, logLine, py, serve } = require("./limits-fixture.cjs");

const FUTURE = 4102444800;      // the year 2100
const PAST = 1000000000;        // the year 2001
const lit = value => `json.loads(${JSON.stringify(JSON.stringify(value))})`;
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "facilitator-limits-unit-")));
const folders = [];
const scratch = () => { const d = tmp(); folders.push(d); return d; };
const boards = [];
const board = async options => { const b = await serve(options); boards.push(b); return b; };

after(async () => {
  for (const b of boards) await b.remove();
  for (const d of folders) fs.rmSync(d, { recursive: true, force: true });
});

// ---- the rules -----------------------------------------------------------------------
test("a window is named by its length, never by the place the reply puts it", () => {
  const cases = [
    { primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 5 },
      secondary: { usedPercent: 20, windowDurationMins: 10080, resetsAt: 6 } },
    { primary: { usedPercent: 33, windowDurationMins: 10080, resetsAt: 7 }, secondary: null },
    { primary: { usedPercent: 33, windowDurationMins: 10080, resetsAt: 7 },
      secondary: { usedPercent: 44, windowDurationMins: 300, resetsAt: 8 } },
    { primary: { used_percent: 5, window_minutes: 300, resets_at: 9 },
      secondary: { used_percent: 6, window_minutes: 10080, resets_at: 10 } },
    { primary: { usedPercent: 50, windowDurationMins: 60, resetsAt: 1 },
      secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 2 } },
    { primary: { usedPercent: 71, windowDurationMins: null, resetsAt: null },
      secondary: { usedPercent: 72, windowDurationMins: null, resetsAt: null } },
    { primary: { windowDurationMins: 300, resetsAt: 1 }, secondary: { usedPercent: "x", windowDurationMins: 10080 } },
    null,
  ];
  const got = py(`import json, limits
print(json.dumps([limits.codex_windows(c) for c in ${lit(cases)}]))`);
  assert.deepEqual(got, [
    { five_hour: { used: 10, resets: 5 }, weekly: { used: 20, resets: 6 } },
    { weekly: { used: 33, resets: 7 } },
    { weekly: { used: 33, resets: 7 }, five_hour: { used: 44, resets: 8 } },
    { five_hour: { used: 5, resets: 9 }, weekly: { used: 6, resets: 10 } },
    { weekly: { used: 12, resets: 2 } },
    { five_hour: { used: 71, resets: null }, weekly: { used: 72, resets: null } },
    {},
    {},
  ]);
});

test("only the account's own bucket is read, never a model's beside it", () => {
  const model = { limitId: "codex_bengalfox", primary: windowOf(99, 300, FUTURE), secondary: windowOf(98, 10080, FUTURE) };
  const results = [
    { rateLimits: model, rateLimitsByLimitId: { codex_bengalfox: model } },
    codexReply(),
    { rateLimits: { limitId: null, primary: windowOf(15, 300, FUTURE), secondary: null } },
    { rateLimits: { limitId: "codex", primary: windowOf(16, 300, FUTURE), secondary: null } },
    {},
    null,
  ];
  const got = py(`import json, limits
print(json.dumps([limits.codex_windows(limits._snapshot(r)) for r in ${lit(results)}]))`);
  assert.deepEqual(got, [
    {},
    { five_hour: { used: 32, resets: FUTURE }, weekly: { used: 61, resets: FUTURE } },
    { five_hour: { used: 15, resets: FUTURE } },
    { five_hour: { used: 16, resets: FUTURE } },
    {},
    {},
  ]);
});

test("a window whose reset time has passed shows 0, and the rest are whole percents from 0 to 100", () => {
  const windows = [
    { five_hour: { used: 40.4, resets: 999 }, weekly: { used: 70, resets: 1000 } },
    { five_hour: { used: 40.4, resets: 1001 }, weekly: { used: 70.5, resets: null } },
    { five_hour: { used: 140, resets: 5000 }, weekly: { used: -3, resets: 5000 }, extra: { used: 5, resets: 1 } },
    {},
  ];
  const got = py(`import json, limits
print(json.dumps([limits.settle(w, 1000.0) for w in ${lit(windows)}]))`);
  assert.deepEqual(got, [
    { five_hour: { used: 0, resets: 999 }, weekly: { used: 0, resets: 1000 } },
    { five_hour: { used: 40, resets: 1001 }, weekly: { used: 70, resets: null } },
    { five_hour: { used: 100, resets: 5000 }, weekly: { used: 0, resets: 5000 } },
    {},
  ]);
});

test("the status line's file gives the two windows it holds and nothing it does not", () => {
  const dir = scratch();
  const file = name => path.join(dir, name);
  fs.writeFileSync(file("both.json"), JSON.stringify({
    five_hour: { used_percentage: 23.5, resets_at: 111 }, seven_day: { used_percentage: 41, resets_at: 222 },
    model: { id: "m" }, session_id: "abc" }));
  fs.writeFileSync(file("week.json"), JSON.stringify({ seven_day: { used_percentage: 9, resets_at: 333 } }));
  fs.writeFileSync(file("odd.json"), JSON.stringify({ five_hour: { used_percentage: "5" }, seven_day: [] }));
  fs.writeFileSync(file("junk.json"), "{not json");
  fs.writeFileSync(file("list.json"), "[]");
  const names = ["both", "week", "odd", "junk", "list", "missing"].map(n => file(n + ".json"));
  const got = py(`import json, limits
print(json.dumps([limits.read_claude(p) for p in ${lit(names)}]))`);
  assert.deepEqual(got, [
    { five_hour: { used: 23.5, resets: 111 }, weekly: { used: 41, resets: 222 } },
    { weekly: { used: 9, resets: 333 } },
    {}, {}, {}, {},
  ]);
});

test("a tool shows only when it has a number: neither tool, either one or both", () => {
  const dir = scratch();
  const bare = path.join(dir, "no-commands");
  fs.mkdirSync(bare);
  const claude = { five_hour: { used_percentage: 12, resets_at: FUTURE }, seven_day: { used_percentage: 34, resets_at: FUTURE } };
  const logged = { primary: { used_percent: 56, window_minutes: 300, resets_at: FUTURE },
                   secondary: { used_percent: 78, window_minutes: 10080, resets_at: FUTURE } };
  const cases = [
    { claude: null, logged: null },
    { claude, logged: null },
    { claude: null, logged },
    { claude, logged },
    { claude: {}, logged: null },
    { claude: { seven_day: claude.seven_day }, logged: { primary: logged.secondary, secondary: null } },
    { claude: null, logged: "raises" },
  ];
  const got = py(`import json, limits, pathlib
d = pathlib.Path(${lit(dir)})
def boom():
    raise RuntimeError("no")
def run(c):
    f = d / "claude-limits.json"
    if f.exists():
        f.unlink()
    if c["claude"] is not None:
        f.write_text(json.dumps(c["claude"]))
    logged = boom if c["logged"] == "raises" else (lambda: c["logged"])
    box = limits.Limits(f, logged, path=${lit(bare)}, clock=lambda: 1000.0)
    return {"shown": box.read(), "source": box.source}
print(json.dumps([run(c) for c in ${lit(cases)}]))`);
  const win = (used, resets = FUTURE) => ({ used, resets });
  assert.deepEqual(got, [
    { shown: {}, source: "none" },
    { shown: { claude: { five_hour: win(12), weekly: win(34) } }, source: "none" },
    { shown: { codex: { five_hour: win(56), weekly: win(78) } }, source: "log" },
    { shown: { claude: { five_hour: win(12), weekly: win(34) }, codex: { five_hour: win(56), weekly: win(78) } }, source: "log" },
    { shown: {}, source: "none" },
    { shown: { claude: { weekly: win(34) }, codex: { weekly: win(78) } }, source: "log" },
    { shown: {}, source: "none" },
  ]);
});

// ---- Codex's app server ---------------------------------------------------------------
test("codex is asked in the app server's own words, and the account's windows come back by length", () => {
  const dir = scratch();
  const codex = installCodex(path.join(dir, "bin"));
  const got = py(`import json, limits
print(json.dumps(limits.ask_codex(${lit(path.join(dir, "bin", "codex"))}, 10.0)))`);
  assert.deepEqual(got, { five_hour: { used: 32, resets: FUTURE }, weekly: { used: 61, resets: FUTURE } });
  assert.deepEqual(codex.calls(), ["initialize", "initialized", "account/rateLimits/read"]);
  assert.equal(codex.starts(), 1);
  codex.setReply(codexReply({ five: null, week: windowOf(7, 10080, FUTURE) }));
  const weekly = py(`import json, limits
print(json.dumps(limits.ask_codex(${lit(path.join(dir, "bin", "codex"))}, 10.0)))`);
  assert.deepEqual(weekly, { weekly: { used: 7, resets: FUTURE } }, "a weekly window alone is the weekly window");
});

test("codex is started once in five minutes, even when it fails", () => {
  const dir = scratch();
  const bin = path.join(dir, "bin");
  const codex = installCodex(bin);
  const run = () => py(`import json, limits
clock = [1000.0]
box = limits.Limits(${lit(path.join(dir, "none.json"))}, lambda: None, path=${lit(bin)}, clock=lambda: clock[0])
seen = []
for t in (1000, 1100, 1299, 1300, 1301, 1599, 1600):
    clock[0] = float(t)
    seen.append(box.read())
    box.idle()
print(json.dumps(seen))`);
  const ok = run();
  assert.equal(codex.starts(), 3, "at 1000, 1300 and 1600 seconds");
  assert.ok(ok.every(r => r.codex.five_hour.used === 32));
  codex.reset();
  codex.setMode("error");
  const failed = run();
  assert.equal(codex.starts(), 3, "a codex that answers with an error is not started every request");
  assert.deepEqual(failed, Array(7).fill({}));
});

test("a reading kept is answered at once, and a stale one is renewed behind the answer", () => {
  const dir = scratch();
  const bin = path.join(dir, "bin");
  const codex = installCodex(bin);
  const later = codexReply({ five: windowOf(50, 300, FUTURE), week: windowOf(80, 10080, FUTURE) });
  const got = py(`import json, limits
clock = [1000.0]
box = limits.Limits(${lit(path.join(dir, "none.json"))}, lambda: None, path=${lit(bin)}, clock=lambda: clock[0])
log = []
def see(label):
    out = box.answer()
    five = out.get("codex", {}).get("five_hour", {}).get("used")
    log.append({"label": label, "five": five, "fetched": out["fetched"], "now": out["now"], "refreshing": out["refreshing"]})
see("first")
open(${lit(path.join(bin, "reply.json"))}, "w").write(json.dumps(${lit(later)}))
clock[0] = 1299.0
see("inside the five minutes")
clock[0] = 1300.0
see("stale")
box.idle()
clock[0] = 1301.0
see("renewed")
open(${lit(path.join(bin, "mode.txt"))}, "w").write("error")
clock[0] = 1600.0
see("failing")
box.idle()
clock[0] = 1601.0
see("kept")
clock[0] = 1899.0
see("not asked again")
print(json.dumps(log))`);
  const by = Object.fromEntries(got.map(g => [g.label, g]));
  assert.deepEqual(by["first"], { label: "first", five: 32, fetched: 1000, now: 1000, refreshing: false });
  assert.deepEqual(by["inside the five minutes"], { label: "inside the five minutes", five: 32, fetched: 1000, now: 1299, refreshing: false });
  assert.deepEqual(by["stale"], { label: "stale", five: 32, fetched: 1000, now: 1300, refreshing: true },
    "the old numbers are answered at once and the renewal runs behind them");
  assert.deepEqual(by["renewed"], { label: "renewed", five: 50, fetched: 1300, now: 1301, refreshing: false });
  assert.deepEqual(by["failing"], { label: "failing", five: 50, fetched: 1300, now: 1600, refreshing: true });
  assert.deepEqual(by["kept"], { label: "kept", five: 50, fetched: 1300, now: 1601, refreshing: false },
    "a renewal that finds nothing keeps the last good reading and its time");
  assert.equal(by["not asked again"].refreshing, false, "the failed ask spaced the next one by five minutes");
  assert.equal(codex.starts(), 3, "at 1000, 1300 and 1600 seconds");
});

test("a renewal that is slow leaves every request answered at once", () => {
  const dir = scratch();
  const bin = path.join(dir, "bin");
  const codex = installCodex(bin);
  const got = py(`import json, limits, time
clock = [1000.0]
box = limits.Limits(${lit(path.join(dir, "none.json"))}, lambda: None, path=${lit(bin)}, clock=lambda: clock[0])
box.read()
open(${lit(path.join(bin, "delay.txt"))}, "w").write("1.5")
clock[0] = 1400.0
seconds = []
flags = []
for k in range(4):
    t = time.monotonic()
    out = box.answer()
    seconds.append(time.monotonic() - t)
    flags.append(out["refreshing"])
box.idle()
print(json.dumps({"seconds": seconds, "flags": flags, "after": box.answer()["refreshing"]}))`);
  assert.ok(got.seconds.every(s => s < 0.5), `the requests took ${got.seconds}`);
  assert.deepEqual(got.flags, [true, true, true, true]);
  assert.equal(got.after, false);
  assert.equal(codex.starts(), 2, "four requests during one renewal start one codex");
});

test("a codex that hangs is stopped at the time limit and the logs answer instead", () => {
  const dir = scratch();
  const bin = path.join(dir, "bin");
  const codex = installCodex(bin, { mode: "hang" });
  const logged = { primary: { used_percent: 21, window_minutes: 10080, resets_at: FUTURE }, secondary: null };
  const got = py(`import json, limits, time
box = limits.Limits(${lit(path.join(dir, "none.json"))}, lambda: ${lit(logged)}, path=${lit(bin)}, timeout=0.6, clock=lambda: 1000.0)
t = time.monotonic()
shown = box.read()
print(json.dumps({"shown": shown, "seconds": time.monotonic() - t, "source": box.source}))`);
  assert.deepEqual(got.shown, { codex: { weekly: { used: 21, resets: FUTURE } } });
  assert.equal(got.source, "log");
  assert.ok(got.seconds < 4, `the whole read took ${got.seconds}s`);
  assert.equal(codex.starts(), 1);
  for (const pid of codex.pids())
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "the stuck codex is gone");
});

test("a codex that answers with an error, or is not installed, falls back to the logs", () => {
  const dir = scratch();
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const logged = { primary: { used_percent: 21, window_minutes: 300, resets_at: FUTURE }, secondary: null };
  const read = () => py(`import json, limits
box = limits.Limits(${lit(path.join(dir, "none.json"))}, lambda: ${lit(logged)}, path=${lit(bin)}, clock=lambda: 1000.0)
print(json.dumps({"shown": box.read(), "source": box.source}))`);
  const missing = read();
  assert.deepEqual(missing, { shown: { codex: { five_hour: { used: 21, resets: FUTURE } } }, source: "log" });
  installCodex(bin, { mode: "error" });
  assert.deepEqual(read(), missing);
});

test("neither limits.py nor the status line script opens a sign-in file or calls a web endpoint", () => {
  for (const name of ["limits.py", "claude-statusline.py"]) {
    const text = fs.readFileSync(path.join(ROOT, name), "utf8");
    assert.doesNotMatch(text, /auth\.json|credentials|\.netrc/i, name);
    assert.doesNotMatch(text, /https?:\/\/|urllib|http\.client|requests|socket|aiohttp/, name);
    assert.equal(text.includes(String.fromCharCode(0x2014)), false, `${name} has a long dash`);
  }
  assert.match(fs.readFileSync(path.join(ROOT, "limits.py"), "utf8"), /\[command, "app-server"\]/);
});

test("the status line's file is kept out of git", () => {
  const ignored = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8").split("\n");
  assert.ok(ignored.includes("/claude-limits.json"));
  assert.ok(ignored.includes("/claude-limits.json.tmp"));
});

// ---- GET /limits ------------------------------------------------------------------------
const numbers = (value, where = "answer") => {
  if (value === null) return;
  if (typeof value === "number") { assert.ok(Number.isFinite(value), where); return; }
  assert.equal(typeof value, "object", `${where} holds only numbers`);
  for (const [k, v] of Object.entries(value)) numbers(v, `${where}.${k}`);
};

// the rows alone: the answer also says when the reading was taken, by the server's
// clock, and whether it is being renewed, which the tests of those keys read whole
const rows = async b => {
  const { fetched, now, refreshing, ...rest } = await b.limits();
  return rest;
};

test("a board with neither tool answers with nothing to show", async () => {
  const b = await (await board()).start();
  assert.deepEqual(await rows(b), {});
});

test("Claude's rows come from the status line's file, read fresh on every request", async () => {
  const b = await (await board({ claude: {
    five_hour: { used_percentage: 12.4, resets_at: FUTURE }, seven_day: { used_percentage: 40, resets_at: FUTURE } } })).start();
  assert.deepEqual(await rows(b), { claude: { five_hour: { used: 12, resets: FUTURE }, weekly: { used: 40, resets: FUTURE } } });
  fs.writeFileSync(b.claudeFile, JSON.stringify({ five_hour: { used_percentage: 77, resets_at: FUTURE } }));
  assert.deepEqual(await rows(b), { claude: { five_hour: { used: 77, resets: FUTURE } } });
  fs.rmSync(b.claudeFile);
  assert.deepEqual(await rows(b), {}, "no file, no rows and no message");
});

test("Codex's rows come from the app server, once in five minutes, and carry only numbers", async () => {
  const b = await (await board({ codex: {} })).start();
  const first = await rows(b);
  assert.deepEqual(first, { codex: { five_hour: { used: 32, resets: FUTURE }, weekly: { used: 61, resets: FUTURE } } });
  b.codex.setReply(codexReply({ five: windowOf(50, 300, FUTURE), week: windowOf(80, 10080, FUTURE) }));
  assert.deepEqual(await rows(b), first, "the next requests are answered from the reading kept");
  assert.deepEqual(await rows(b), first);
  assert.equal(b.codex.starts(), 1);
  assert.deepEqual(b.codex.calls(), ["initialize", "initialized", "account/rateLimits/read"]);
  numbers(first);
  assert.deepEqual(Object.keys(first), ["codex"]);
  assert.deepEqual(Object.keys(first.codex).sort(), ["five_hour", "weekly"]);
  for (const w of Object.values(first.codex)) assert.deepEqual(Object.keys(w).sort(), ["resets", "used"]);
});

test("both tools show together, and a window already over shows 0", async () => {
  const b = await (await board({ codex: { reply: codexReply({
    five: windowOf(55, 300, PAST), week: windowOf(61, 10080, FUTURE) }) },
    claude: { five_hour: { used_percentage: 90, resets_at: FUTURE }, seven_day: { used_percentage: 95, resets_at: PAST } } })).start();
  assert.deepEqual(await rows(b), {
    claude: { five_hour: { used: 90, resets: FUTURE }, weekly: { used: 0, resets: PAST } },
    codex: { five_hour: { used: 0, resets: PAST }, weekly: { used: 61, resets: FUTURE } },
  });
});

test("the answer says when Codex was read, by the server's clock, and whether it is being renewed", async () => {
  const before = Math.floor(Date.now() / 1000);
  const b = await (await board({ codex: {} })).start();
  const first = await b.limits();
  assert.deepEqual(Object.keys(first).sort(), ["codex", "fetched", "now", "refreshing"]);
  assert.ok(Number.isInteger(first.fetched) && first.fetched >= before - 1 && first.fetched <= first.now, "the fetch time is a whole second");
  assert.ok(Math.abs(first.now - Date.now() / 1000) < 5, "now is the server's own clock");
  assert.equal(first.refreshing, false);
  const again = await b.limits();
  assert.equal(again.fetched, first.fetched, "a request inside the five minutes leaves the fetch time alone");
});

test("a stale reading is answered at once by the board, and renewed behind the answer", async () => {
  const b = await (await board({ codex: {}, every: 1 })).start();
  const first = await b.limits();
  assert.equal(first.codex.five_hour.used, 32);
  b.codex.setReply(codexReply({ five: windowOf(50, 300, FUTURE), week: windowOf(80, 10080, FUTURE) }));
  b.codex.setDelay(1.5);
  await new Promise(resolve => setTimeout(resolve, 1200));
  const asked = Date.now();
  const stale = await b.limits();
  assert.ok(Date.now() - asked < 700, "the answer did not wait for the app server");
  assert.equal(stale.codex.five_hour.used, 32, "the numbers kept are answered");
  assert.equal(stale.fetched, first.fetched);
  assert.equal(stale.refreshing, true);
  let fresh = stale;
  for (let k = 0; k < 40 && fresh.refreshing; k++) {
    await new Promise(resolve => setTimeout(resolve, 150));
    fresh = await b.limits();
  }
  assert.equal(fresh.refreshing, false);
  assert.equal(fresh.codex.five_hour.used, 50);
  assert.ok(fresh.fetched > first.fetched, "the fetch time moved with the renewal");
  assert.equal(b.codex.starts(), 2);
});

test("with no codex command, the newest limits in its session logs answer, never a model's", async () => {
  const b = await board();
  const sessions = path.join(b.home, ".codex", "sessions", "2026", "09", "20");
  fs.mkdirSync(sessions, { recursive: true });
  const file = path.join(sessions, "rollout-a.jsonl");
  fs.writeFileSync(file, [
    logLine("2026-09-20T10:00:00Z", "codex", [10, 300, FUTURE], [20, 10080, FUTURE]),
    logLine("2026-09-20T11:00:00Z", "codex", [31, 300, FUTURE], [62, 10080, FUTURE]),
    logLine("2026-09-20T12:00:00Z", "codex_bengalfox", [99, 300, FUTURE], [98, 10080, FUTURE]),
    logLine("2026-09-20T09:00:00Z", "codex", [1, 300, FUTURE], [2, 10080, FUTURE]),
  ].join("\n") + "\n");
  await b.start();
  const answer = await rows(b);
  assert.deepEqual(answer, { codex: { five_hour: { used: 31, resets: FUTURE }, weekly: { used: 62, resets: FUTURE } } });
  assert.equal(b.codex, null, "no codex was started: there is none");
  // what the board keeps of them is numbers and nothing else
  const kept = JSON.parse(fs.readFileSync(b.cacheFile, "utf8")).limits;
  numbers(kept, "kept");
  assert.deepEqual(Object.keys(kept).sort(), ["at", "primary", "secondary"]);
  assert.deepEqual(Object.keys(kept.primary).sort(), ["resets_at", "used_percent", "window_minutes"]);
  // a cache from before the limits were kept has read the file whole and will
  // not read it again, so the file's end is searched once
  await b.stop();
  const cache = JSON.parse(fs.readFileSync(b.cacheFile, "utf8"));
  delete cache.limits;
  fs.writeFileSync(b.cacheFile, JSON.stringify(cache));
  await b.start();
  assert.deepEqual(await rows(b), answer);
});

test("a codex that cannot answer leaves the session logs to do it, and the route still answers", async () => {
  const b = await board({ codex: { mode: "error" } });
  const sessions = path.join(b.home, ".codex", "sessions", "2026", "09", "21");
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, "rollout-b.jsonl"),
    logLine("2026-09-21T10:00:00Z", "codex", [44, 10080, FUTURE], null) + "\n");
  await b.start();
  assert.deepEqual(await rows(b), { codex: { weekly: { used: 44, resets: FUTURE } } });
  assert.equal(b.codex.starts(), 1);
});

test("the route logs the source and the number of tools, and no path, number or name", async () => {
  const b = await board({ level: "debug", codex: {},
    claude: { five_hour: { used_percentage: 12.4, resets_at: FUTURE } } });
  await b.start();
  await b.limits();
  const lines = b.logLines().map(l => JSON.parse(l));
  const asked = lines.filter(l => l.kind === "limits");
  assert.equal(asked.length, 1);
  assert.deepEqual(Object.keys(asked[0]).sort(), ["kind", "level", "source", "tools", "ts"]);
  assert.equal(asked[0].source, "app-server");
  assert.equal(asked[0].tools, 2);
  const everything = b.logLines().join("\n");
  for (const secret of [b.dir, b.home, "claude-limits", "auth", "used_percentage", "usedPercent"])
    assert.ok(!everything.includes(secret), `the log carries ${secret}`);
});
