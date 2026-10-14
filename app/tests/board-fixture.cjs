// A copy of the board on a free pair of ports in a throwaway folder, with the
// page files the desktop and phone pages need, for the tests that talk to the
// whole server. Nothing here touches port 8877.
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { request } = require("node:http");
const { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { copyBridgeFiles, freePortPair } = require("./fixture-auth.cjs");

const ROOT = path.resolve(__dirname, "..");
const PAGE_FILES = ["index.html", "page.html", "m.html", "m-sw.js", "m-manifest.json", "sw.js", "manifest.json",
  "cm-markdown.js", "compose-format.js", "card-markdown.js", "card-logic.js", "card-report.js", "card-tokens.css"];
const SEED = { title: "fixture board", items: [
  { id: "0", bucket: "meta", title: "Standing meta card", owner: "facilitator" },
  { id: "1.1", bucket: "now", title: "Fixture lane", owner: "pastureland", context: "Invented lane" },
] };

// seed, config: the board's first words and its run.config.json. env: extra
// environment. extra: more files from the repo to copy beside the server.
// prepare: called with the folders once the files are in place, before the
// server starts
async function startBoard({ seed = SEED, config, env = {}, extra = [], prepare } = {}) {
  const outer = await mkdtemp(path.join(tmpdir(), "facilitator-fixture-"));
  const app = path.join(outer, "app");
  const logs = path.join(outer, "logs");
  await mkdir(app);
  const port = await freePortPair();
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  if (patched === source) throw new Error("test server port was not patched");
  await writeFile(path.join(app, "server.py"), patched);
  copyBridgeFiles(app);
  for (const name of [...PAGE_FILES, ...extra]) await copyFile(path.join(ROOT, name), path.join(app, name));
  await mkdir(path.join(app, "assets"));
  for (const name of await readdir(path.join(ROOT, "assets")))
    await copyFile(path.join(ROOT, "assets", name), path.join(app, "assets", name));
  await writeFile(path.join(app, "seed.json"), JSON.stringify(seed));
  if (config) await writeFile(path.join(app, "run.config.json"), JSON.stringify(config));
  if (prepare) await prepare({ app, logs, outer });

  const origin = `http://127.0.0.1:${port}`;
  const board = { app, logs, origin, outer, port, child: null };
  async function launch() {
    const child = spawn(process.env.FACILITATOR_TEST_PYTHON || "python3", [path.join(app, "server.py")], {
      cwd: app,
      env: { ...process.env, FACILITATOR_TEST_PORT: String(port), FACILITATOR_LOG_DIR: logs, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", bytes => { output += bytes; });
    const deadline = Date.now() + 10000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`fixture server exited:\n${output}`);
      try { if ((await fetch(origin + "/state")).ok) break; } catch {}
      if (Date.now() > deadline) throw new Error(`fixture server did not start:\n${output}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    board.child = child;
  }
  async function halt() {
    const child = board.child;
    if (child && child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
  }
  await launch();
  return Object.assign(board, {
    // one raw request to the board's own port, as its own page would make it
    call(method, route, body, headers = {}) {
      return new Promise((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, method, path: route,
          headers: { Host: `127.0.0.1:${port}`, Origin: origin, "Sec-Fetch-Site": "same-origin", ...headers } }, res => {
          const chunks = [];
          res.on("data", chunk => chunks.push(chunk));
          res.on("end", () => resolve({ status: res.statusCode, headers: res.headers,
            text: Buffer.concat(chunks).toString("utf8") }));
        });
        req.on("error", reject);
        req.end(body);
      });
    },
    // stop the server, leave the folder as it is, and start the same board again
    async restart(between) { await halt(); if (between) await between(); await launch(); },
    async stop() { await halt(); await rm(outer, { recursive: true, force: true }); },
  });
}

module.exports = { ROOT, startBoard };
