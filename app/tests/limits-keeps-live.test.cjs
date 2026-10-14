// A failed read of Codex must not put an old number in place of a good one: the
// session-log fallback is used only until Codex has answered once in a server
// run, a reading from the logs carries the log record's own time, and each
// change of source writes one info line with the reason. The Codex here is a
// small fake on a PATH of its own, so no real codex is started, and HOME points
// into the fixture, so no real log is read. Every number is invented.
const assert = require("node:assert/strict");
const { after, test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { installCodex, codexReply, windowOf, logLine, py, serve } = require("./limits-fixture.cjs");

const FUTURE = 4102444800;      // the year 2100
const DAY = 86400;
const lit = value => `json.loads(${JSON.stringify(JSON.stringify(value))})`;
const folders = [];
const scratch = () => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "facilitator-limits-live-")));
  folders.push(d);
  return d;
};
const boards = [];

after(async () => {
  for (const b of boards) await b.remove();
  for (const d of folders) fs.rmSync(d, { recursive: true, force: true });
});

// the weekly window alone, as Codex has been sending it
const weekly = used => codexReply({ five: null, week: windowOf(used, 10080, FUTURE) });
// the newest log record: 55% from two days before the clock below
const NOW = 1791482486;
const OLD = NOW - 2 * DAY;
const record = { at: OLD, primary: { used_percent: 55, window_minutes: 10080, resets_at: FUTURE } };

// a run of asks on a fake clock: each step sets a mode of the fake codex ("" for
// none installed), moves the clock past the five minutes, asks, waits for any
// renewal, and reports what the page would be told and what was noted
function run(dir, steps, { logged = record } = {}) {
  return py(`import json, limits, os
bin = ${lit(path.join(dir, "bin"))}
clock = [float(${NOW})]
notes = []
box = limits.Limits(${lit(path.join(dir, "none.json"))}, lambda: ${lit(logged)}, path=bin,
                    timeout=10.0, clock=lambda: clock[0],
                    note=lambda old, new, why: notes.append([old, new, why]))
out = []
for k, mode in enumerate(${lit(steps)}):
    clock[0] = float(${NOW} + k * 400)
    if mode == "gone":
        os.remove(os.path.join(bin, "codex"))
    elif mode:
        open(os.path.join(bin, "mode.txt"), "w").write(mode)
    box.timeout = 0.6 if mode == "hang" else 10.0   # a cold fake takes a while to start
    box.answer()
    box.idle()
    clock[0] += 1
    a = box.answer()
    out.append({"weekly": a.get("codex", {}).get("weekly", {}).get("used"), "fetched": a["fetched"],
                "now": a["now"], "source": box.source, "notes": len(notes)})
print(json.dumps({"out": out, "notes": notes}))`);
}

test("a live 0% stays when the next read fails, with its own time, whatever the failure", () => {
  const dir = scratch();
  installCodex(path.join(dir, "bin"), { reply: weekly(0) });
  // ok, then an error reply, a good one, a hang, and no codex at all
  const got = run(dir, ["ok", "error", "ok", "hang", "gone"]);
  // the second ask is 400 seconds after the first, so it is a renewal each time
  const shown = got.out.map(o => [o.weekly, o.fetched === NOW ? "first" : o.fetched - NOW, o.source]);
  assert.deepEqual(shown[0], [0, "first", "app-server"]);
  assert.deepEqual(shown[1], [0, "first", "kept"], "the error left 0 and the time it was taken");
  assert.equal(got.out[1].fetched, NOW);
  assert.equal(got.out[2].weekly, 0);
  assert.equal(got.out[2].fetched, NOW + 800, "a good read after a failed one is the new reading");
  assert.deepEqual(got.out.slice(3).map(o => [o.weekly, o.fetched, o.source]),
    [[0, NOW + 800, "kept"], [0, NOW + 800, "kept"]], "a hang and a missing codex keep it too");
  assert.deepEqual(got.notes, [
    ["app-server", "kept", "error"],
    ["kept", "app-server", null],
    ["app-server", "kept", "timeout"],
  ], "one line for each switch, none for the second failure in a row");
});

test("a codex with no limits in its answer is a reason, and the live number stays", () => {
  const dir = scratch();
  const codex2 = installCodex(path.join(dir, "bin"), { reply: weekly(0) });
  const mixed = py(`import json, limits
clock = [float(${NOW})]
notes = []
box = limits.Limits(${lit(path.join(dir, "none.json"))}, lambda: ${lit(record)}, path=${lit(path.join(dir, "bin"))},
                    clock=lambda: clock[0], note=lambda *a: notes.append(list(a)))
box.read()
open(${lit(path.join(dir, "bin", "reply.json"))}, "w").write("{}")
clock[0] += 400
box.read()
box.idle()
print(json.dumps({"shown": box.read(), "notes": notes, "fetched": box.answer()["fetched"]}))`);
  assert.equal(codex2.starts(), 2);
  assert.deepEqual(mixed.shown, { codex: { weekly: { used: 0, resets: FUTURE } } });
  assert.deepEqual(mixed.notes, [["app-server", "kept", "no limits"]]);
  assert.equal(mixed.fetched, NOW);
});

test("a cold start with Codex unreachable shows the log record with the record's own time", () => {
  const dir = scratch();
  fs.mkdirSync(path.join(dir, "bin"));
  const got = run(dir, [""]);
  assert.deepEqual(got.out[0], { weekly: 55, fetched: OLD, now: NOW + 1, source: "log", notes: 1 });
  assert.deepEqual(got.notes, [["none", "log", "not started"]]);
  assert.ok(got.out[0].now - got.out[0].fetched >= 2 * DAY, "two days old by the server's clock");
});

test("a log record from the future is not dated later than now", () => {
  const dir = scratch();
  fs.mkdirSync(path.join(dir, "bin"));
  const got = run(dir, [""], { logged: { ...record, at: NOW + 5000 } });
  assert.equal(got.out[0].fetched, NOW);
});

test("a live read after a fallback replaces it, and the log is not asked while a live reading stands", () => {
  const dir = scratch();
  const codex = installCodex(path.join(dir, "bin"), { reply: weekly(0), mode: "error" });
  const got = py(`import json, limits, os
bin = ${lit(path.join(dir, "bin"))}
clock = [float(${NOW})]
notes = []
looked = []
def logged():
    looked.append(clock[0])
    return ${lit(record)}
box = limits.Limits(${lit(path.join(dir, "none.json"))}, logged, path=bin, clock=lambda: clock[0],
                    note=lambda old, new, why: notes.append([old, new, why]))
steps = []
def step(mode):
    clock[0] = ${NOW} + 400 * (len(steps))
    open(os.path.join(bin, "mode.txt"), "w").write(mode)
    box.answer()
    box.idle()
    a = box.answer()
    steps.append([a["codex"]["weekly"]["used"], a["fetched"] - ${NOW}, box.source])
box.answer()
steps.append([box.answer()["codex"]["weekly"]["used"], box.answer()["fetched"] - ${NOW}, box.source])
step("error")
step("ok")
step("error")
print(json.dumps({"steps": steps, "notes": notes, "looked": len(looked)}))`);
  assert.deepEqual(got.steps, [
    [55, -2 * DAY, "log"],
    [55, -2 * DAY, "log"],
    [0, 800, "app-server"],
    [0, 800, "kept"],
  ]);
  assert.deepEqual(got.notes, [
    ["none", "log", "error"],
    ["log", "app-server", null],
    ["app-server", "kept", "error"],
  ], "once per switch");
  assert.equal(got.looked, 2, "the log was read at the cold start and the next ask, and never after codex answered");
  assert.equal(codex.starts(), 4);
});

test("the board writes one info line for each switch, with no path, number or name", async () => {
  const b = await serve({ codex: { mode: "error" }, every: 1 });
  boards.push(b);
  const sessions = path.join(b.home, ".codex", "sessions", "2026", "10", "06");
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, "rollout-c.jsonl"),
    logLine("2026-10-06T18:01:26.791Z", "codex", [55, 10080, FUTURE], null) + "\n");
  b.codex.setReply(weekly(0));
  await b.start();
  const sources = () => b.logLines().map(l => JSON.parse(l)).filter(l => l.kind === "limitsource");
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const settled = async () => {
    let a = await b.limits();
    for (let k = 0; k < 40 && a.refreshing; k++) { await wait(150); a = await b.limits(); }
    return a;
  };

  const cold = await b.limits();
  assert.equal(cold.codex.weekly.used, 55);
  assert.equal(cold.fetched, Math.floor(Date.parse("2026-10-06T18:01:26.791Z") / 1000), "the record's own time");
  assert.ok(cold.now - cold.fetched > DAY, "it says it is old");
  await wait(1200);
  await settled();                                   // codex still failing: a log that stands
  assert.equal(sources().length, 1);
  b.codex.setMode("ok");
  await wait(1200);
  const live = await settled();
  assert.equal(live.codex.weekly.used, 0);
  assert.ok(live.now - live.fetched < 60);
  b.codex.setMode("error");
  await wait(1200);
  const kept = await settled();
  await wait(1200);
  await settled();
  assert.equal(kept.codex.weekly.used, 0, "a failed read keeps the live 0");
  assert.equal(kept.fetched, live.fetched, "and its time");
  const lines = sources();
  assert.deepEqual(lines.map(l => [l.level, l.old, l.new, l.reason]), [
    ["info", "none", "log", "error"],
    ["info", "log", "app-server", undefined],
    ["info", "app-server", "kept", "error"],
  ]);
  for (const l of lines) assert.deepEqual(Object.keys(l).sort().filter(k => k !== "reason"), ["kind", "level", "new", "old", "ts"]);
  const everything = b.logLines().join("\n");
  for (const secret of [b.dir, b.home, "claude-limits", "auth", "used_percent", "usedPercent", "rollout"])
    assert.ok(!everything.includes(secret), `the log carries ${secret}`);
});
