const assert = require("node:assert/strict");
const { test } = require("node:test");
const { execFile, spawn } = require("node:child_process");
const { once } = require("node:events");
const { createServer } = require("node:http");
const { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const { copyBridgeFiles } = require("./fixture-auth.cjs");
const { appFolder, dataOf } = require("./fixture-auth.cjs");

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(__dirname, "..");
const LEGACY_COMMIT = "143ee72";

async function freePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

function withTestPort(source) {
  const patched = source.replace(
    "PORT = 8877",
    "PORT = int(os.environ['FACILITATOR_TEST_PORT'])",
  );
  assert.notEqual(patched, source, "fixture server port was not patched");
  return patched;
}

// logs, when given, keeps every run's dated files in the sandbox: a legacy
// server would otherwise write them beside its own folder
function launch(file, cwd, port, logs) {
  const run = {
    child: spawn("python3", [file], {
      cwd,
      env: { ...process.env, FACILITATOR_TEST_PORT: String(port), ...(logs ? { FACILITATOR_LOG_DIR: logs } : {}) },
      stdio: ["ignore", "pipe", "pipe"],
    }),
    output: "",
  };
  for (const stream of [run.child.stdout, run.child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", chunk => { run.output += chunk; });
  }
  return run;
}

async function waitReady(run, origin) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (run.child.exitCode !== null)
      throw new Error(`fixture server exited early:\n${run.output}`);
    try {
      if ((await fetch(origin + "/state")).ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`fixture server did not become ready:\n${run.output}`);
}

async function waitExit(run) {
  if (run.child.exitCode !== null) return run.child.exitCode;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(
      new Error(`fixture process did not exit:\n${run.output}`)), 5000);
    run.child.once("exit", code => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function stop(run) {
  if (run && run.child.exitCode === null && run.child.signalCode === null) {
    run.child.kill("SIGTERM");
    await once(run.child, "exit");
  }
}

async function snapshot(file) {
  try {
    return { exists: true, bytes: await readFile(file) };
  } catch (error) {
    if (error.code === "ENOENT") return { exists: false };
    throw error;
  }
}

test("a startup that loses the port cannot migrate under the running legacy server", async () => {
  // as an older checkout stands right after its update pulled the new code:
  // the legacy server still running from the checkout's top, with its files
  // there, and the new server in app/ beside it
  const outer = await mkdtemp(path.join(tmpdir(), "facilitator-startup-overlap-"));
  const fixture = path.join(outer, "app");
  await mkdir(fixture);
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const logs = path.join(outer, "logs");
  let legacyRun;
  let correctedRun;
  try {
    const currentSource = await readFile(path.join(ROOT, "server.py"), "utf8");
    const { stdout: legacySource } = await execFileAsync(
      "git", ["show", `${LEGACY_COMMIT}:server.py`],
      { cwd: ROOT, maxBuffer: 4 * 1024 * 1024 },
    );
    const legacyFile = path.join(outer, "server.py");
    const correctedFile = path.join(fixture, "server.py");
    await writeFile(legacyFile, withTestPort(legacySource));
    await writeFile(correctedFile, withTestPort(currentSource));
    // the legacy server's gate files beside it, without the profile
    // copyBridgeFiles would give it: it keeps its own files at outer's top
    for (const name of ["bridge_auth.py", "bridge_gate.py", "m-gate.html"])
      await writeFile(path.join(outer, name), await readFile(path.join(ROOT, name)));
    copyBridgeFiles(fixture);
    await writeFile(path.join(outer, "seed.json"), JSON.stringify({
      title: "overlap fixture",
      items: [{
        id: "m1", bucket: "meta", title: "Overlap", owner: "facilitator",
        context: "Initial reply",
      }],
    }));

    legacyRun = launch(legacyFile, outer, port, logs);
    await waitReady(legacyRun, origin);
    const statePath = path.join(outer, "state.json");
    const transcriptPath = path.join(outer, "transcript.jsonl");
    const beforeState = await snapshot(statePath);
    const beforeTranscript = await snapshot(transcriptPath);

    const losingRun = launch(correctedFile, fixture, port, logs);
    const losingCode = await waitExit(losingRun);
    assert.equal(losingCode, 1);
    // the board's files are still in their old place, so the new server stays
    // down before it binds or opens anything, and says why in one line
    assert.match(losingRun.output, /still in their old place/);
    assert.match(losingRun.output, /Run facilitator update to move them into data\//);
    assert.doesNotMatch(losingRun.output, /Traceback/);
    assert.deepEqual(await snapshot(statePath), beforeState,
      "losing startup rewrote state before it owned the port");
    assert.deepEqual(await snapshot(transcriptPath), beforeTranscript,
      "losing startup wrote a transcript boundary before it owned the port");
    assert.deepEqual(await snapshot(path.join(outer, "data", "state.json")), { exists: false },
      "losing startup wrote a state of its own into data/");

    const late = "Late compact\n---\nLate full";
    const reply = await fetch(origin + "/reply?box=m1", { method: "POST", body: late });
    assert.equal(reply.status, 200, "legacy owner could not write after the rejected startup");
    await stop(legacyRun);

    // the update's move, as facilitator update runs it, then the new server
    await execFileAsync(process.env.FACILITATOR_TEST_PYTHON || "python3", ["-c",
      "import data_folder, pathlib, sys\n"
      + "clone = pathlib.Path(sys.argv[1])\n"
      + "with data_folder.Locks(clone):\n"
      + "    data_folder.move(clone, data_folder.plan(clone))\n", outer], { cwd: fixture });
    correctedRun = launch(correctedFile, fixture, port, logs);
    await waitReady(correctedRun, origin);
    const state = await (await fetch(origin + "/state")).json();
    const migrated = state.boxes.find(box => box.id === "m1");
    assert.equal(migrated.replyFull, "Late full");
    assert.equal(migrated.replyShort, "Late compact");

    const thread = await (await fetch(origin + "/thread?box=m1&n=20")).json();
    const latest = thread.messages.filter(message => message.kind === "agent").at(-1);
    assert.equal(latest.text, "Late full");
    assert.equal(latest.replyFull, "Late full");
    assert.equal(latest.replyShort, "Late compact");

    const transcript = (await readFile(path.join(outer, "data", "transcript.jsonl"), "utf8")).trim().split("\n")
      .map(line => JSON.parse(line));
    const lateAt = transcript.findIndex(row => row.kind === "agent" && row.text === late);
    const markerAt = transcript.findIndex(row => row.kind === "schema" &&
      row.schema === "reply_variants" && row.version === 1);
    assert.ok(lateAt >= 0 && markerAt > lateAt,
      "schema boundary was not persisted after the last legacy row");
  } finally {
    await stop(correctedRun);
    await stop(legacyRun);
    await rm(outer, { recursive: true, force: true });
  }
});

test("a truncated transcript tail stays separate from the durable schema boundary", async () => {
  const outer = await mkdtemp(path.join(tmpdir(), "facilitator-truncated-boundary-"));
  const fixture = path.join(outer, "app");
  await mkdir(fixture);
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  let run;
  try {
    const source = await readFile(path.join(ROOT, "server.py"), "utf8");
    const serverFile = path.join(fixture, "server.py");
    await writeFile(serverFile, withTestPort(source));
    copyBridgeFiles(fixture);
    await writeFile(path.join(dataOf(fixture), "seed.json"), JSON.stringify({
      title: "truncated boundary fixture",
      items: [{
        id: "m1", bucket: "meta", title: "Boundary", owner: "facilitator",
        context: "Fresh text",
      }],
    }));
    const legacyText = "Old compact\n---\nOld full";
    const truncated = '{"ts":2,"kind":"agent"';
    const transcriptPath = path.join(dataOf(fixture), "transcript.jsonl");
    await writeFile(transcriptPath,
      JSON.stringify({ ts: 1, kind: "agent", box: "m1", text: legacyText }) +
      "\n" + truncated);

    // This is the one corrected restart. It must terminate the damaged line
    // before appending the migration marker.
    run = launch(serverFile, fixture, port);
    await waitReady(run, origin);
    const migratedLines = (await readFile(transcriptPath, "utf8")).split("\n");
    assert.equal(migratedLines[1], truncated);
    const marker = JSON.parse(migratedLines[2]);
    assert.deepEqual(marker, { kind: "schema", schema: "reply_variants", version: 1 });
    assert.equal(migratedLines.filter(line => {
      try {
        const row = JSON.parse(line);
        return row.kind === "schema" && row.schema === "reply_variants" && row.version === 1;
      } catch {
        return false;
      }
    }).length, 1);

    const laterText = "Later compact\n---\nLater full";
    await appendFile(transcriptPath,
      JSON.stringify({ kind: "agent", box: "m1", text: laterText }) + "\n");
    const thread = await (await fetch(origin + "/thread?box=m1&n=20")).json();
    const agents = thread.messages.filter(message => message.kind === "agent");
    assert.deepEqual([agents[0].replyShort, agents[0].replyFull],
      ["Old compact", "Old full"]);
    assert.equal(agents[1].text, laterText);
    assert.equal(agents[1].replyShort, laterText);
    assert.equal(agents[1].replyFull, laterText);
  } finally {
    await stop(run);
    await rm(outer, { recursive: true, force: true });
  }
});
