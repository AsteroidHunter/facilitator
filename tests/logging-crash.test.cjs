// A crash the board never meant: a request that throws, and a start that dies
// of something rather than being asked to stop. Both used to leave a traceback
// on standard error, which nothing is reading once the CLI starts the server,
// so both are lines in the dated file now. What a line may carry is most of the
// point here: the exception's type always, its own words only when they are
// plain words, and where it happened with no path anywhere in it. Each case
// runs its own fixture server on its own free port; the suite never touches
// port 8877.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createServer } = require("node:http");
const { mkdir, mkdtemp, readFile, readdir, rm, writeFile } = require("node:fs/promises");
const { homedir, tmpdir } = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
// what the fixture throws when nothing else is asked for: plain words, which is
// what a line is allowed to keep
const PLAIN = "the fixture asked for this";
// and what an interpreter says when it choked on something a caller sent: the
// value itself, in quotes, which is what a line must drop
const QUOTED = "invalid literal for int() with base 10: 'ff'";

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

// a fixture folder with a copy of the server in it, patched twice: onto a free
// port, and with two ways to make it throw. A route that raises is the only way
// to reach the application's own error path without waiting for a real bug,
// and a raise where the server is run is the fatal case the stop line has to
// follow.
async function fixture(name) {
  const dir = await mkdtemp(path.join(tmpdir(), `facilitator-${name}-`));
  const app = path.join(dir, "app");
  await mkdir(app);
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  let patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "test server port was not patched");
  const route = [
    "def _crash_fixture(q, _):",
    `    raise ValueError(q.one("say", "${PLAIN}"))`,
    "",
    "",
    "ROUTES = [",
    '    Route("/crashfixture", _endpoint(_crash_fixture), methods=["GET"]),',
  ].join("\n");
  const before = patched;
  patched = patched.replace("ROUTES = [", route);
  assert.notEqual(patched, before, "the throwing route was not patched in");
  const fatal = [
    '        if os.environ.get("FACILITATOR_TEST_FATAL"):',
    `            raise ValueError("${PLAIN}")`,
    "        server.run(sockets=[sock, bridge_sock])",
  ].join("\n");
  const beforeFatal = patched;
  patched = patched.replace("        server.run(sockets=[sock, bridge_sock])", fatal);
  assert.notEqual(patched, beforeFatal, "the fatal start was not patched in");
  await writeFile(path.join(app, "server.py"), patched);
  require('./fixture-auth.cjs').copyBridgeFiles(require('node:path').dirname(path.join(app, "server.py")));
  await writeFile(path.join(app, "seed.json"), JSON.stringify({
    title: "crash fixture",
    items: [{ id: "0", bucket: "meta", title: "Standing meta card", owner: "facilitator" }],
  }));
  return { dir, app, logs: path.join(dir, "logs") };
}

function launch(place, port, extra = {}) {
  const run = {
    child: spawn("python3", [path.join(place.app, "server.py")], {
      cwd: place.app,
      env: { ...process.env, FACILITATOR_TEST_PORT: String(port),
             FACILITATOR_LOG_DIR: place.logs, ...extra },
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

async function crashesUntil(place, howMany, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const seen = (await events(place)).filter(event => event.kind === "crash");
    if (seen.length >= howMany) return seen;
    if (Date.now() > deadline) throw new Error(`${seen.length} crash lines, wanted ${howMany}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

test("a request that throws writes one crash line, and no path is in any field", async () => {
  const place = await fixture("crash");
  const port = await freePort();
  const run = launch(place, port);
  const origin = `http://127.0.0.1:${port}`;
  try {
    await waitReady(run, origin);
    // the request is answered rather than dropped: a 500 the page can read,
    // saying nothing about where the board lives
    const answered = await fetch(origin + "/crashfixture");
    assert.equal(answered.status, 500);
    const said = await answered.json();
    assert.ok(said.error && !said.error.includes("/"), JSON.stringify(said));

    const [thrown] = await crashesUntil(place, 1);
    assert.equal(thrown.level, "error");
    assert.equal(thrown.error, "ValueError");
    assert.equal(thrown.message, PLAIN, "the line dropped words it was allowed to keep");
    assert.equal(thrown.route, "/crashfixture", "the crash line does not name the route");
    assert.match(thrown.where, /^server\.py:_crash_fixture:\d+$/, `a strange place: ${thrown.where}`);
    assert.ok(Array.isArray(thrown.frames) && thrown.frames.length >= 1);
    assert.equal(thrown.frames.at(-1), thrown.where, "the place is not the innermost frame");
    for (const frame of thrown.frames) assert.match(frame, /^[^/]+:[^/]+:\d+$/, frame);
    // every value the line carries, checked for anywhere this could have run.
    // The route is the one field that is a slash by nature: it is the request
    // path, which the refusal lines carry too, and never a file's
    for (const [name, value] of Object.entries(thrown)) {
      const written = JSON.stringify(value);
      if (name !== "route") assert.ok(!written.includes("/"), `${name} carries a path: ${written}`);
      assert.ok(!written.includes(place.dir), `${name} carries a path: ${written}`);
      assert.ok(!written.includes(homedir()), `${name} carries a path: ${written}`);
    }
    // and the board is still standing: one request threw, the server did not
    assert.ok((await fetch(origin + "/state")).ok, "a thrown request took the board down");

    // a message an interpreter phrased by quoting what a caller sent is dropped
    // whole, and the line still says what type it was
    assert.equal((await fetch(`${origin}/crashfixture?say=${encodeURIComponent(QUOTED)}`)).status, 500);
    const quoted = (await crashesUntil(place, 2)).at(-1);
    assert.equal(quoted.error, "ValueError");
    assert.equal(quoted.message, undefined, `quoted text reached the log: ${quoted.message}`);
    assert.match(quoted.where, /^server\.py:_crash_fixture:\d+$/);
    assert.ok((await fetch(origin + "/state")).ok);
  } finally {
    if (run.child.exitCode === null) {
      run.child.kill("SIGKILL");
      await once(run.child, "exit");
    }
    await rm(place.dir, { recursive: true, force: true });
  }
});

test("a start that dies writes the crash first and the stop line after it", async () => {
  const place = await fixture("fatal");
  const port = await freePort();
  const run = launch(place, port, { FACILITATOR_TEST_FATAL: "1" });
  try {
    const end = await once(run.child, "exit");
    assert.equal(end[0], 1, `a fatal start left with ${end[0]}: ${run.output}`);
    const written = await events(place);
    const kinds = written.map(event => event.kind);
    assert.deepEqual(kinds, ["start", "crash", "stop"], kinds.join(", "));
    const crashed = written[1];
    assert.equal(crashed.level, "error");
    assert.equal(crashed.error, "ValueError");
    assert.equal(crashed.message, PLAIN);
    assert.match(crashed.where, /^server\.py:main:\d+$/, crashed.where);
    // the stop line still says which type ended the run, as it always did
    assert.equal(written[2].reason, "ValueError");
  } finally {
    if (run.child.exitCode === null) {
      run.child.kill("SIGKILL");
      await once(run.child, "exit");
    }
    await rm(place.dir, { recursive: true, force: true });
  }
});
