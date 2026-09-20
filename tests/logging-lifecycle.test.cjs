// What the file says about a server going up and coming down. A start with no
// matching stop was all the log remembered about a restart, which is why one
// could not be explained afterwards. Each case runs its own fixture server on
// its own free port; the suite never touches port 8877.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createServer } = require("node:http");
const { mkdir, mkdtemp, readFile, readdir, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

function today() {
  const now = new Date();
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}` +
    `${String(now.getDate()).padStart(2, "0")}`;
}

async function freePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const chosen = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return chosen;
}

// a fixture folder with the patched server and a two card seed in it, plus its
// own log folder, so one case can never read another's lines
async function fixture(name) {
  const dir = await mkdtemp(path.join(tmpdir(), `facilitator-${name}-`));
  const app = path.join(dir, "app");
  await mkdir(app);
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "test server port was not patched");
  await writeFile(path.join(app, "server.py"), patched);
  require('./fixture-auth.cjs').copyBridgeFiles(require('node:path').dirname(path.join(app, "server.py")));
  await writeFile(path.join(app, "seed.json"), JSON.stringify({
    title: "lifecycle fixture",
    items: [
      { id: "0", bucket: "meta", title: "Standing meta card", owner: "facilitator" },
      { id: "1.1", bucket: "now", title: "A lane card", owner: "pastureland" },
    ],
  }));
  return { dir, app, logs: path.join(dir, "logs") };
}

function launch(place, port) {
  const run = {
    child: spawn("python3", [path.join(place.app, "server.py")], {
      cwd: place.app,
      env: { ...process.env, FACILITATOR_TEST_PORT: String(port), FACILITATOR_LOG_DIR: place.logs },
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
    if (run.child.exitCode !== null) throw new Error(`fixture server exited:\n${run.output}`);
    try {
      if ((await fetch(origin + "/state")).ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`fixture server did not start:\n${run.output}`);
}

async function events(place) {
  const out = [];
  for (const name of (await readdir(place.logs)).sort()) {
    for (const line of (await readFile(path.join(place.logs, name), "utf8")).split("\n")) {
      if (line !== "") out.push(JSON.parse(line));
    }
  }
  return out;
}

async function eventsUntil(place, kind, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const seen = await events(place);
    if (seen.some(event => event.kind === kind)) return seen;
    if (Date.now() > deadline) throw new Error(`no ${kind} line was written`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

test("a start writes one start line with the port it bound and the level in force", async () => {
  const place = await fixture("start");
  const port = await freePort();
  const run = launch(place, port);
  try {
    await waitReady(run, `http://127.0.0.1:${port}`);
    const written = await eventsUntil(place, "start");
    const starts = written.filter(event => event.kind === "start");
    assert.equal(starts.length, 1, "more than one start line for one start");
    assert.equal(starts[0].level, "info");
    assert.equal(starts[0].log_level, "info", "the start line does not say which level is in force");
    assert.equal(starts[0].port, port);
    assert.equal(starts[0].boxes, 4, "the start line does not count the board's cards");
    assert.equal(starts[0].push_ok, undefined, "a board with no push ever sent claims one");
    assert.equal(starts[0].box, undefined);
    // and the file it wrote to is the day's own, and is the only place it
    // wrote at all: a pipe is not a terminal, so nothing is mirrored to one
    assert.ok((await readdir(place.logs)).includes(`server-${today()}.log`));
    assert.equal(run.output, "", `the start wrote to its own output: ${run.output}`);
  } finally {
    run.child.kill("SIGKILL");
    await once(run.child, "exit");
    await rm(place.dir, { recursive: true, force: true });
  }
});

test("a stopping signal is named in one stop line, and the process leaves cleanly", async () => {
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    const place = await fixture("stop");
    const port = await freePort();
    const run = launch(place, port);
    try {
      await waitReady(run, `http://127.0.0.1:${port}`);
      run.child.kill(signal);
      const end = await once(run.child, "exit");
      assert.deepEqual(end, [0, null], `${signal}: ${run.output}`);
      const stops = (await events(place)).filter(event => event.kind === "stop");
      assert.equal(stops.length, 1, `${signal}: ${stops.length} stop lines`);
      assert.equal(stops[0].reason, signal);
      assert.equal(stops[0].level, "info");
      // a stop line always follows the start line it belongs to
      const written = (await events(place)).map(event => event.kind);
      assert.ok(written.indexOf("start") < written.lastIndexOf("stop"));
      assert.doesNotMatch(run.output, /Traceback/);
    } finally {
      if (run.child.exitCode === null) {
        run.child.kill("SIGKILL");
        await once(run.child, "exit");
      }
      await rm(place.dir, { recursive: true, force: true });
    }
  }
});

test("a second server on a taken port writes an error line and exits one", async () => {
  const place = await fixture("taken");
  const port = await freePort();
  const holder = launch(place, port);
  let loser;
  try {
    await waitReady(holder, `http://127.0.0.1:${port}`);
    loser = launch(place, port);
    const end = await once(loser.child, "exit");
    assert.equal(end[0], 1, loser.output);
    const refused = (await events(place)).filter(event => event.kind === "bindfail");
    assert.equal(refused.length, 1);
    assert.equal(refused[0].level, "error");
    assert.equal(refused[0].port, port);
    assert.match(refused[0].reason, /could not listen on 127\.0\.0\.1:/);
    // the losing start says so in the file and nowhere else: no terminal is
    // watching it here, and it leaves quietly rather than on a traceback
    assert.equal(loser.output, "", `the losing start wrote to its output: ${loser.output}`);
    // the one that owns the port is untouched by the refusal
    assert.ok((await fetch(`http://127.0.0.1:${port}/state`)).ok);
  } finally {
    holder.child.kill("SIGKILL");
    await once(holder.child, "exit");
    await rm(place.dir, { recursive: true, force: true });
  }
});
