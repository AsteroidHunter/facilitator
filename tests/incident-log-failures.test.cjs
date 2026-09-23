const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { copyFile, mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { promisify } = require("node:util");
const run = promisify(execFile);

test("confirmed incident writes report disk failure, retain rate capacity, and use dated rotation", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "facilitator-incident-log-"));
  try {
    await copyFile(path.join(__dirname, "..", "server.py"), path.join(dir, "server.py"));
    require('./fixture-auth.cjs').copyBridgeFiles(require('node:path').dirname(path.join(dir, "server.py")));
    const { stdout } = await run(process.env.FACILITATOR_TEST_PYTHON || "python3", ["-c", `
import json, logging
from pathlib import Path
import server as s
r = {"kind":"incident", "v":1, "reason":"manual", "marked":1800000000000,
     "box":"m12", "lost":0, "suppressed":0, "events":[
       {"event":"mark", "reason":"manual", "at":0, "visible":True, "online":True, "resume":0}]}
raw = json.dumps({"page":"phone", "reports":[r]}).encode()
original = s._client_file.emit_confirmed
def fail(record):
    raise OSError("fixture full disk")
s._client_file.emit_confirmed = fail
assert s._post_clientlog(s.Query(), raw) == (503, {"error":"the diagnostic log could not be written"})
assert s._client_seen["incident|phone"][1] == 0
s._client_file.emit_confirmed = original
assert s._post_clientlog(s.Query(), raw) == (200, {"ok":True, "written":1, "dropped":0})
lines = [json.loads(line) for f in s.LOG_DIR.glob("client-*.jsonl") for line in f.read_text().splitlines()]
assert len(lines) == 1 and lines[0]["events"] == r["events"]
s._client_file.maxBytes = 250
for n in range(40):
    record = s.CLIENT_LOGGER.makeRecord(s.CLIENT_LOGGER.name, logging.INFO, "", 0, "incident", (), None,
        extra={"box":"m12", "fields":{"page":"phone", "events":r["events"]}})
    s._client_file.emit_confirmed(record)
files = list(s.LOG_DIR.glob("client-*.jsonl"))
assert len(files) == s.LOG_KEEP
assert all(json.loads(line)["kind"] == "incident" for f in files for line in f.read_text().splitlines())
print("Confirmed failure/success and existing dated size/count rotation passed")
`], { cwd: dir, env: { ...process.env, FACILITATOR_LOG_DIR: path.join(dir, "logs") } });
    assert.match(stdout, /passed/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a v5 no-scroll history is written whole, and its schema-4 fallback shape is still written as v4", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "facilitator-incident-v5-"));
  try {
    await copyFile(path.join(__dirname, "..", "server.py"), path.join(dir, "server.py"));
    require('./fixture-auth.cjs').copyBridgeFiles(require('node:path').dirname(path.join(dir, "server.py")));
    const { stdout } = await run(process.env.FACILITATOR_TEST_PYTHON || "python3", ["-c", `
import json
import server as s
def event(name, at, **fields):
    return {"event":name, **fields, "at":at, "visible":True, "online":True, "resume":1}
def report(v, reason, events):
    return {"kind":"incident", "v":v, "reason":reason, "marked":1800000000000, "box":"m12",
            "lost":0, "suppressed":0, "build":"phone-scroll-diag-test",
            "worker":"facilitator-m-7", "session":"0123456789abcdef", "events":events}
swipe = [
    event("input", -400, action="response-scroll", part="touch", box="m12", top=120, range=900,
          view=500, edge="middle", hist=False, kb=False, focus="none", lag=4),
    event("input", -380, action="response-scroll", part="intent", box="m12", dir="up", far=True,
          edge="middle", lag=3),
    event("mark", 0, reason="no-scroll", box="m12"),
    event("input", 50, action="response-scroll", part="touch-cancel", box="m12", moved=0, count=0,
          ms=450, same=True, prevented=False),
    event("input", 60, action="response-scroll", part="taken", box="m12", by="scrim", side="left"),
    event("phase", 200, action="response-scroll", part="reply-swap", box="m12", hist=True, ms=600),
    event("scroll", 500, action="response-scroll", phase="start", box="m12", wait=900)]
# what the phone's schema-4 fallback sends for the same swipe
older = [
    event("input", -400, action="response-scroll", part="touch", box="m12", kb=False),
    event("input", -380, action="response-scroll", part="intent", box="m12"),
    event("mark", 0, reason="manual", box="m12"),
    event("input", 50, action="response-scroll", part="touch-end", box="m12", count=0, ms=450),
    event("scroll", 500, action="response-scroll", phase="start", box="m12")]
post = lambda r: s._post_clientlog(s.Query(), json.dumps({"page":"phone", "reports":[r]}).encode())
assert s.INCIDENT_SCHEMA == 5
assert post(report(5, "no-scroll", swipe)) == (200, {"ok":True, "written":1, "dropped":0})
assert post(report(4, "manual", older)) == (200, {"ok":True, "written":1, "dropped":0})
assert post(report(3, "manual", older)) == (200, {"ok":True, "written":1, "dropped":0})
lines = [json.loads(line) for f in s.LOG_DIR.glob("client-*.jsonl") for line in f.read_text().splitlines()]
assert [(l["v"], l["reason"]) for l in lines] == [(5, "no-scroll"), (4, "manual"), (3, "manual")], lines
assert lines[0]["events"] == swipe
# no older version reads a v5 reason, field or part
assert not s._incident_valid("phone", report(4, "no-scroll", [event("mark", 0, reason="no-scroll")]))
for v in (3, 4):
    for extra in (dict(top=5), dict(part="touch-cancel"), dict(part="taken"), dict(prevented=True)):
        changed = [dict(e) for e in older]
        changed[3].update(extra)
        assert not s._incident_valid("phone", report(v, "manual", changed)), (v, extra)
assert not s._incident_valid("phone", {**report(5, "no-scroll", swipe), "v":6})
print("v5 write, v4/v3 fallback writes and older-version refusals passed")
`], { cwd: dir, env: { ...process.env, FACILITATOR_LOG_DIR: path.join(dir, "logs") } });
    assert.match(stdout, /passed/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("slow requests are thresholded, bounded by route, and accept only canonical operation correlation", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "facilitator-slow-request-"));
  try {
    await copyFile(path.join(__dirname, "..", "server.py"), path.join(dir, "server.py"));
    require('./fixture-auth.cjs').copyBridgeFiles(require('node:path').dirname(path.join(dir, "server.py")));
    const { stdout } = await run(process.env.FACILITATOR_TEST_PYTHON || "python3", ["-c", `
import server as s
seen = []
s._info = lambda *args, **fields: seen.append((args, fields))
s._slow_request("/send", s.Query(), 200, 999)
s._slow_request("/state", s.Query(), 200, 5000)
assert not seen
op = "12345678-1234-4234-8234-123456789abc"
for n in range(25):
    s._slow_request("/send", s.Query({"op":[op], "box":["m12"]}), 200, 1000)
assert len(seen) == 10
assert all(args == ("slowrequest", "m12") and fields["op"] == op for args, fields in seen)
s._slow_requests["/send"][0] -= 61
s._slow_request("/send", s.Query({"op":["private-token"], "box":["person@example.invalid"]}), 503, 2000)
assert seen[-1][0] == ("slowrequest", "")
assert seen[-1][1]["op"] is None and seen[-1][1]["dropped"] == 15
print("Slow threshold, rate bound and correlation privacy passed")
`], { cwd: dir, env: { ...process.env, FACILITATOR_LOG_DIR: path.join(dir, "logs") } });
    assert.match(stdout, /passed/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
