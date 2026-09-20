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
