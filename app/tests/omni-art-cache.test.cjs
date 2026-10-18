// The three Omni ticket artwork files may be kept by the browser, so a card's
// picture shows at once after a project switch; nothing else changes. An
// attachment under /uploads and the other files under /assets still carry
// no-store, on the board's port and on the phone's.
//
// The server here is a real copy in a temp directory behind a fake Tailscale
// CLI, on ports the OS picks, and every request is plain HTTP. Nothing here
// opens a browser or touches port 8877, and the board is invented.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { execFileSync, spawn } = require("node:child_process");
const http = require("node:http");
const { chmod, copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { appFolder, dataOf } = require("./fixture-auth.cjs");

const ROOT = path.resolve(__dirname, "..");
const PASS = "OmniArtFixture7!";
const COPIED = ["m.html", "m-sw.js", "m-manifest.json", "card-markdown.js", "card-tokens.css",
                "card-logic.js", "card-report.js", "compose-format.js", "cm-markdown.js",
                "index.html", "page.html", "manifest.json", "sw.js"];
// what one open of the app asks the board for, besides the page itself: the
// files its head and body name
const OPEN_FILES = ["/card-markdown.js", "/card-logic.js", "/magic-box.js", "/card-report.js",
                    "/compose-format.js", "/home-widgets.js", "/m-splash.js"];
const typeOf = route => (route.endsWith(".css") ? "text/css; charset=utf-8" : "application/javascript; charset=utf-8");

let outer = "";
let port = 0;
let child = null;
let output = "";
let cookie = "";

// one request on its own socket, the body left exactly as it came
function request(onPort, route, headers = {}, method = "GET", body = null) {
  return new Promise((resolve, reject) => {
    const bytes = body == null ? null : Buffer.from(body);
    const req = http.request({
      host: "127.0.0.1", port: onPort, path: route, method, agent: false,
      headers: { ...(bytes ? { "content-length": bytes.length } : {}), ...headers },
    }, res => {
      const parts = [];
      res.on("data", part => parts.push(part));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(parts) }));
    });
    req.on("error", reject);
    req.end(bytes);
  });
}

// the two doors, each as a browser at it would ask
const board = (route, accept) => request(port, route, accept ? { "Accept-Encoding": accept } : {});
const phone = (route, accept) =>
  request(port + 1, route, { Cookie: cookie, ...(accept ? { "Accept-Encoding": accept } : {}) });

before(async () => {
  outer = await mkdtemp(path.join(tmpdir(), "facilitator-m1298-omni-art-"));
  const app = path.join(outer, "app");
  const bin = path.join(outer, "bin");
  await mkdir(app);
  await mkdir(bin);
  await writeFile(path.join(bin, "tailscale"), "#!/bin/sh\necho '{}'\n");
  await chmod(path.join(bin, "tailscale"), 0o755);
  const source = (await readFile(path.join(ROOT, "server.py"), "utf8"))
    .replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])")
    .replace('TAILSCALE_APP = "/Applications/Tailscale.app/Contents/MacOS/Tailscale"',
             'TAILSCALE_APP = "/facilitator-test/no-tailscale-app"');
  assert.match(source, /PORT = int\(os\.environ\['FACILITATOR_TEST_PORT'\]\)/, "the port was not patched");
  assert.match(source, /TAILSCALE_APP = "\/facilitator-test\/no-tailscale-app"/,
    "the fixture could fall through to the real Tailscale app");
  await writeFile(path.join(app, "server.py"), source);
  require("./fixture-auth.cjs").copyBridgeFiles(app);
  for (const name of COPIED) await copyFile(path.join(ROOT, name), path.join(app, name));
  await cp(path.join(ROOT, "assets"), path.join(app, "assets"), { recursive: true });
  await writeFile(path.join(dataOf(app), "seed.json"), JSON.stringify({
    title: "m1298 omni art fixture board",
    items: [{ id: "0", bucket: "now", title: "An invented card", owner: "facilitator", context: "Invented." }],
  }));
  const python = process.env.FACILITATOR_TEST_PYTHON ||
    execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
  execFileSync(python, ["-c", `import bridge_auth; bridge_auth.set_password(${JSON.stringify(PASS)})`], { cwd: app });
  port = await require("./fixture-auth.cjs").freePortPair();
  child = spawn(python, [path.join(app, "server.py")], {
    cwd: app,
    env: { ...process.env, PATH: bin + path.delimiter + "/usr/bin:/bin",
           FACILITATOR_TEST_PORT: String(port), FACILITATOR_LOG_DIR: path.join(outer, "logs") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", chunk => { output += chunk; });
  }
  const deadline = Date.now() + 15000;
  for (;;) {
    if (child.exitCode !== null) throw new Error("fixture server exited early:\n" + output);
    try { if ((await request(port + 1, "/auth/check")).status === 200) break; } catch {}
    if (Date.now() > deadline) throw new Error("fixture server never answered:\n" + output);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const login = await request(port + 1, "/auth/login",
    { Origin: `http://127.0.0.1:${port + 1}`, "Content-Type": "application/json" },
    "POST", JSON.stringify({ password: PASS }));
  assert.equal(login.status, 200, login.bytes.toString());
  cookie = (login.headers["set-cookie"] || [])[0]?.split(";")[0];
  assert.ok(cookie, "the fixture sign-in issued no session");
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise(resolve => child.once("exit", resolve));
  }
  if (outer) await rm(outer, { recursive: true, force: true });
});


const ART = [1, 2, 3].map(n => `/assets/ticket-${n}.webp`);
const KEPT = /^private, max-age=(\d+)$/;

test("each Omni ticket artwork is kept for a day, on both ports, and comes back whole", async () => {
  for (const [door, ask] of [["board port", board], ["phone port", phone]]) {
    for (const route of ART) {
      const answer = await ask(route, "gzip");
      assert.equal(answer.status, 200, `${door} ${route}`);
      const kept = KEPT.exec(answer.headers["cache-control"] || "");
      assert.ok(kept, `${door} ${route} says ${answer.headers["cache-control"]}`);
      assert.equal(Number(kept[1]), 86400, `${door} ${route} max-age`);
      assert.equal(answer.headers["content-type"], "image/webp", `${door} ${route} type`);
      assert.equal(answer.headers["content-encoding"], undefined, `${door} ${route} was compressed`);
      assert.deepEqual(answer.bytes, await readFile(path.join(ROOT, "assets", path.basename(route))), `${door} ${route} bytes`);
    }
  }
});

test("an attachment and the other assets files still carry no-store", async () => {
  const uploads = path.join(dataOf(path.join(outer, "app")), "uploads");
  await mkdir(uploads, { recursive: true });
  await copyFile(path.join(ROOT, "assets", "m-icon-180.png"), path.join(uploads, "1700000000000-a.png"));
  for (const [door, ask] of [["board port", board], ["phone port", phone]]) {
    for (const route of ["/uploads/1700000000000-a.png", "/assets/m-icon-180.png", "/m-icon-180.png",
                         "/m-splash-squid.png", "/uploads/1700000000000-missing.png"]) {
      const answer = await ask(route);
      assert.equal(answer.headers["cache-control"], "no-store", `${door} ${route}`);
    }
    assert.equal((await ask("/uploads/1700000000000-a.png")).status, 200, door + " the attachment");
  }
});

test("the board and the gate leave the artwork's header alone, and a missing name is no-store", async () => {
  // the sign-in gate answers a phone with no session before the board is asked
  const unsigned = await request(port + 1, ART[0]);
  assert.equal(unsigned.status, 401);
  assert.equal(unsigned.headers["cache-control"], "no-store");
  const missing = await board("/assets/ticket-4.webp");
  assert.notEqual(missing.status, 200);
  assert.equal(missing.headers["cache-control"], "no-store");
});
