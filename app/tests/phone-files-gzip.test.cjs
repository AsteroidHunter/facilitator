// The page and its shared files go out gzip compressed, as the phone's readings
// do, on the board's port and on the phone's, and only to a browser that says it
// takes gzip. A phone that opens the app on a slow line moves about a third of
// the bytes it did.
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
const PASS = "GzipFixture7!";
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
  outer = await mkdtemp(path.join(tmpdir(), "facilitator-m1178-gzip-"));
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
    title: "m1178 gzip fixture board",
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

// the answer's bytes as the browser would hand them to the page
const plain = answer => (answer.headers["content-encoding"] === "gzip" ? zlib.gunzipSync(answer.bytes) : answer.bytes);

test("a browser that takes gzip gets each shared file compressed, on both ports, and the same bytes back", async () => {
  const routes = ["/card-markdown.js", "/card-logic.js", "/card-tokens.css", "/compose-format.js",
                  "/card-report.js", "/magic-box.js", "/home-widgets.js", "/home-widgets.css",
                  "/m-splash.js", "/m-sw.js", "/cm-markdown.js"];
  for (const [door, ask] of [["board port", board], ["phone port", phone]]) {
    for (const route of routes) {
      const whole = await ask(route);
      assert.equal(whole.status, 200, `${door} ${route}`);
      assert.equal(whole.headers["content-encoding"], undefined, `${door} ${route} was compressed for a browser that did not ask`);
      const packed = await ask(route, "gzip, deflate, br");
      assert.equal(packed.status, 200, `${door} ${route}`);
      assert.equal(packed.headers["content-encoding"], "gzip", `${door} ${route} was not compressed`);
      assert.match(packed.headers["vary"], /Accept-Encoding/i, `${door} ${route} says nothing of what it varies on`);
      assert.equal(packed.headers["cache-control"], "no-store", `${door} ${route} lost its no-store`);
      assert.equal(whole.headers["content-type"], typeOf(route), `${door} ${route} type`);
      assert.equal(packed.headers["content-type"], whole.headers["content-type"], `${door} ${route} changed type`);
      assert.equal(Number(packed.headers["content-length"]), packed.bytes.length, `${door} ${route} length`);
      assert.deepEqual(plain(packed), whole.bytes, `${door} ${route} came back different`);
      assert.ok(packed.bytes.length < whole.bytes.length * 0.6, `${door} ${route} saved too little: ${packed.bytes.length} of ${whole.bytes.length}`);
    }
  }
});

test("the pages go compressed too, the phone's with the sheet folded in, and come back whole", async () => {
  for (const [route, ask] of [["/", board], ["/page", board], ["/m", phone]]) {
    const whole = await ask(route);
    const packed = await ask(route, "gzip");
    assert.equal(packed.headers["content-encoding"], "gzip", route);
    assert.deepEqual(plain(packed), whole.bytes, route);
    assert.ok(packed.bytes.length < whole.bytes.length * 0.5, `${route}: ${packed.bytes.length} of ${whole.bytes.length}`);
  }
  const page = plain(await phone("/m", "gzip")).toString("utf8");
  assert.ok(page.includes('<style data-sheet="/card-tokens.css">'), "the sheet is no longer folded into the phone page");
  // and the board's own port answers /m with no sign-in needed there
  assert.equal((await board("/m", "gzip")).headers["content-encoding"], "gzip");
});

test("a browser that does not take gzip gets the bytes as they are", async () => {
  for (const accept of [null, "identity", "br", "gzip;q=0", "deflate"]) {
    for (const [route, ask] of [["/card-logic.js", board], ["/card-logic.js", phone], ["/m", phone], ["/", board]]) {
      const answer = await ask(route, accept);
      assert.equal(answer.status, 200);
      assert.equal(answer.headers["content-encoding"], undefined, `${route} compressed for ${accept}`);
    }
  }
  // "*" takes it, as for a reading
  assert.equal((await board("/card-logic.js", "*")).headers["content-encoding"], "gzip");
});

test("pictures and readings are left as they were", async () => {
  const icon = await phone("/m-icon-180.png", "gzip");
  assert.equal(icon.status, 200);
  assert.equal(icon.headers["content-encoding"], undefined, "a picture was put through gzip");
  assert.equal(icon.headers["content-type"], "image/png");
  assert.deepEqual(icon.bytes, await readFile(path.join(ROOT, "assets", "m-icon-180.png")));
  const reading = await phone("/m/state?since=", "gzip");
  assert.equal(reading.status, 200);
  assert.equal(reading.headers["content-encoding"], "gzip");   // as it already was
  assert.ok(Number.isSafeInteger(JSON.parse(plain(reading)).rev), "the reading is not a reading");
});

test("one open of the app moves about a third of the bytes it did", async () => {
  let before = 0;
  let after = 0;
  for (const route of ["/m", ...OPEN_FILES]) {
    const whole = await phone(route);
    const packed = await phone(route, "gzip, deflate, br");
    assert.equal(whole.status, 200, route);
    assert.equal(packed.status, 200, route);
    before += whole.bytes.length;
    after += packed.bytes.length;
  }
  assert.ok(before > 700 * 1024, "the open is smaller than it was measured to be: " + before);
  assert.ok(after < before * 0.4, `an open moved ${after} of ${before} bytes`);
});
