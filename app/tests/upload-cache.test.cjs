// A card's attachment may be kept by the browser: /uploads answers with
// "private, max-age=31536000, immutable" and still carries nosniff and the
// sandbox policy, on the Mac route and through the phone's bridge gate, while a
// missing upload, a refused name and a signed-out request are never stored.
// A copied server on spare ports with its own state folder and a password made
// for this run.
const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const { spawn, execFileSync } = require("node:child_process");
const { once } = require("node:events");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { copyBridgeFiles, dataOf, freePortPair } = require("./fixture-auth.cjs");

const ROOT = path.resolve(__dirname, "..");
const PYTHON = process.env.FACILITATOR_TEST_PYTHON || "python3";
const PASS = "Tp" + crypto.randomBytes(8).toString("hex") + "9!";
const NAME = "__Host-facilitator_session";
const KEPT = "private, max-age=31536000, immutable";
const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"), Buffer.alloc(2048, 7)]);
const FILES = {
  "1760000000000-card.png": PNG,
  "1760000000001-clip.mp4": Buffer.concat([Buffer.from("00000018", "hex"), Buffer.from("ftypmp42"), Buffer.alloc(2048, 3)]),
  "1760000000002-notes.pdf": Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(512, 1)]),
};
let fixture;

function request(port, route, method = "GET", body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const bytes = body == null ? null : Buffer.from(body);
    const req = http.request({ hostname: "127.0.0.1", port, path: route, method,
      headers: { ...(bytes ? { "content-length": bytes.length } : {}), ...headers } }, res => {
      const parts = [];
      res.on("data", part => parts.push(part));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers,
        cookies: res.headers["set-cookie"] || [], body: Buffer.concat(parts) }));
    });
    req.on("error", reject);
    req.end(bytes);
  });
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

before(async () => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "facilitator-upload-cache-"));
  const app = path.join(outer, "app");
  fs.mkdirSync(app);
  const source = fs.readFileSync(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "test server port was not patched");
  fs.writeFileSync(path.join(app, "server.py"), patched);
  copyBridgeFiles(app);
  for (const name of ["index.html", "m.html", "m-sw.js", "m-manifest.json", "card-markdown.js", "card-tokens.css",
    "card-logic.js", "card-report.js", "compose-format.js", "cm-markdown.js", "home-widgets.js", "home-widgets.css",
    "tokens.py", "seed.example.json", "page.html", "manifest.json", "sw.js"])
    fs.copyFileSync(path.join(ROOT, name), path.join(app, name));
  fs.cpSync(path.join(ROOT, "assets"), path.join(app, "assets"), { recursive: true });
  const uploads = path.join(dataOf(app), "uploads");
  fs.mkdirSync(uploads, { recursive: true, mode: 0o700 });
  for (const [name, bytes] of Object.entries(FILES)) fs.writeFileSync(path.join(uploads, name), bytes, { mode: 0o600 });
  execFileSync(PYTHON, ["-c", `import bridge_auth; bridge_auth.set_password(${JSON.stringify(PASS)})`], { cwd: app });
  const port = await freePortPair();
  const env = { ...process.env, FACILITATOR_TEST_PORT: String(port), FACILITATOR_LOG_DIR: path.join(outer, "logs") };
  const child = spawn(PYTHON, [path.join(app, "server.py")], { cwd: app, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { output += data; });
  fixture = { outer, port, bridge: port + 1, child, origin: `http://127.0.0.1:${port + 1}` };
  for (let i = 0; ; i++) {
    if (child.exitCode !== null) throw new Error(`fixture server exited:\n${output}`);
    try { if ((await request(port + 1, "/auth/check")).status === 200) break; } catch {}
    if (i > 300) throw new Error(`fixture server did not start:\n${output}`);
    await pause(50);
  }
  const login = await request(fixture.bridge, "/auth/login", "POST", JSON.stringify({ password: PASS }),
    { Origin: fixture.origin });
  assert.equal(login.status, 200, login.body.toString());
  fixture.cookie = { Cookie: login.cookies[0].split(";")[0] };
});

after(async () => {
  if (!fixture) return;
  if (fixture.child.exitCode === null) { fixture.child.kill("SIGTERM"); await once(fixture.child, "exit"); }
  fs.rmSync(fixture.outer, { recursive: true, force: true });
});

function keptWithGuards(answer, label) {
  assert.equal(answer.status, 200, label);
  assert.equal(answer.headers["cache-control"], KEPT, label);
  assert.equal(answer.headers["x-content-type-options"], "nosniff", label);
  assert.equal(answer.headers["content-security-policy"], "sandbox", label);
}

test("the Mac route lets the browser keep a picture, a video and a document, and still guards them", async () => {
  for (const [name, bytes] of Object.entries(FILES)) {
    const answer = await request(fixture.port, "/uploads/" + name);
    keptWithGuards(answer, name);
    assert.deepEqual(answer.body, bytes, name);
  }
  keptWithGuards(await request(fixture.port, "/uploads/1760000000000-card.png?download=1"), "download");
});

test("the phone's bridge gate passes the same header through for a signed-in phone", async () => {
  for (const [name, bytes] of Object.entries(FILES)) {
    const answer = await request(fixture.bridge, "/uploads/" + name, "GET", null, fixture.cookie);
    keptWithGuards(answer, name);
    assert.deepEqual(answer.body, bytes, name);
  }
});

test("a missing upload and a refused name are not cacheable, on both routes", async () => {
  for (const [port, headers] of [[fixture.port, {}], [fixture.bridge, fixture.cookie]]) {
    for (const route of ["/uploads/1760000000009-gone.png", "/uploads/", "/uploads/..", "/uploads/a%2Fb.png"]) {
      const answer = await request(port, route, "GET", null, headers);
      assert.equal(answer.status, 404, route);
      assert.equal(answer.headers["cache-control"], "no-store", route);
    }
  }
});

test("a phone that is not signed in is turned away with no-store, and so is one that signed out", async () => {
  const route = "/uploads/1760000000000-card.png";
  const anonymous = await request(fixture.bridge, route);
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers["cache-control"], "no-store");
  assert.equal(anonymous.body.includes(PNG.subarray(8, 16)), false);
  const out = await request(fixture.bridge, "/auth/logout", "POST", "", { ...fixture.cookie, Origin: fixture.origin });
  assert.equal(out.status, 200);
  const after = await request(fixture.bridge, route, "GET", null, fixture.cookie);
  assert.equal(after.status, 401);
  assert.equal(after.headers["cache-control"], "no-store");
});
