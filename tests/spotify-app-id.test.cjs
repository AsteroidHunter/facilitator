// The Spotify app id is machine-local. The server reads spotify_client_id from
// run.config.json and hands it to the page on /state, and the page it serves
// carries no id of its own. Server side only: a scratch board on a free port,
// no live board and no port 8877.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createServer } = require("node:http");
const { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const PYTHON = process.env.FACILITATOR_TEST_PYTHON || path.join(ROOT, ".venv", "bin", "python3");
const INVENTED = "invented-spotify-app-id-31415926";

let baseDir;
let serverSource;
let seq = 0;
const running = [];

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

// A server of its own in a scratch directory, on a free port, given only the
// config the case names. index.html is copied verbatim so the served page is
// the one this repo ships.
async function startServer(config) {
  const dir = path.join(baseDir, "srv-" + (++seq));
  await mkdir(dir, { recursive: true });
  const port = await freePort();
  await writeFile(path.join(dir, "server.py"), serverSource);
  await copyFile(path.join(ROOT, "index.html"), path.join(dir, "index.html"));
  if (config !== undefined) {
    await writeFile(path.join(dir, "run.config.json"), JSON.stringify(config));
  }
  await writeFile(path.join(dir, "seed.json"), JSON.stringify({
    title: "spotify id fixture",
    items: [{ id: "0", bucket: "meta", title: "Standing card", owner: "facilitator" }],
  }));

  const origin = "http://127.0.0.1:" + port;
  const child = spawn(PYTHON, [path.join(dir, "server.py")], {
    cwd: dir,
    env: { ...process.env, FACILITATOR_TEST_PORT: String(port), FACILITATOR_LOG_DIR: dir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  running.push(child);
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("server exited early:\n" + output);
    try { if ((await fetch(origin + "/state")).ok) return { origin, child }; } catch (error) {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  child.kill("SIGKILL");
  throw new Error("server did not start:\n" + output);
}

before(async () => {
  baseDir = await mkdtemp(path.join(tmpdir(), "facilitator-spotify-id-"));
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  serverSource = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(serverSource, source, "fixture server port was not patched");
});

after(async () => {
  for (const child of running) {
    if (child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
  }
  if (baseDir) await rm(baseDir, { recursive: true, force: true });
});

test("a configured id reaches the page on the board state", async () => {
  const { origin } = await startServer({ spotify_client_id: INVENTED });
  const state = await (await fetch(origin + "/state")).json();
  assert.equal(state.spotifyClientId, INVENTED,
    "the board state did not carry the configured Spotify id");
  const page = await (await fetch(origin + "/")).text();
  assert.ok(!page.includes(INVENTED),
    "the configured Spotify id leaked into the served page");
});

test("no configured id leaves the state id empty", async () => {
  const { origin } = await startServer({});
  const state = await (await fetch(origin + "/state")).json();
  assert.equal(state.spotifyClientId, "",
    "an unset Spotify id should read as empty on the state");
});

test("the served page inlines no Spotify id literal", async () => {
  const { origin } = await startServer({ spotify_client_id: INVENTED });
  const page = await (await fetch(origin + "/")).text();
  assert.ok(/SPOT_ID/.test(page), "the served page no longer names SPOT_ID");
  assert.ok(!/SPOT_ID\s*=\s*["'][^"']+["']/.test(page),
    "the served page still assigns SPOT_ID a literal id");
});
