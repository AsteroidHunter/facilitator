// The sign-in cookie is SameSite=Lax, a signed-in page open sends it again, a
// turned-away request writes one rate-limited log line, and cross-site writes
// are still refused with the Lax cookie present. A copied server on spare ports
// with its own state folder, log folder and a password made for this run.
const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const { spawn, execFileSync } = require("node:child_process");
const { once } = require("node:events");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { copyBridgeFiles, freePortPair } = require("./fixture-auth.cjs");

const ROOT = path.resolve(__dirname, "..");
const PYTHON = process.env.FACILITATOR_TEST_PYTHON || path.join(ROOT, ".venv/bin/python3");
const PASS = "Tp" + crypto.randomBytes(8).toString("hex") + "9!";
const NAME = "__Host-facilitator_session";
const PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
let fixture;

function request(port, route, method = "GET", body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const bytes = body == null ? null : Buffer.from(body);
    const req = http.request({ hostname: "127.0.0.1", port, path: route, method,
      headers: { ...(bytes ? { "content-length": bytes.length } : {}), ...headers } }, res => {
      const parts = [];
      res.on("data", part => parts.push(part));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers,
        cookies: res.headers["set-cookie"] || [], text: Buffer.concat(parts).toString() }));
    });
    req.on("error", reject);
    req.end(bytes);
  });
}

const refusals = () => {
  const folder = path.join(fixture.outer, "logs");
  const file = fs.readdirSync(folder).find(name => name.startsWith("server-"));
  const text = fs.readFileSync(path.join(folder, file), "utf8");
  return { text, lines: text.split("\n").filter(Boolean).map(line => JSON.parse(line))
    .filter(line => line.kind === "signinrefused") };
};
const sessions = () => JSON.parse(fs.readFileSync(path.join(fixture.app, "bridge-auth.json"), "utf8")).sessions.length;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

before(async () => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "facilitator-gate-cookie-"));
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
  execFileSync(PYTHON, ["-c", `import bridge_auth; bridge_auth.set_password(${JSON.stringify(PASS)})`], { cwd: app });
  const port = await freePortPair();
  const env = { ...process.env, FACILITATOR_TEST_PORT: String(port), FACILITATOR_LOG_DIR: path.join(outer, "logs") };
  const child = spawn(PYTHON, [path.join(app, "server.py")], { cwd: app, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { output += data; });
  fixture = { outer, app, port, bridge: port + 1, child, origin: `http://127.0.0.1:${port + 1}` };
  for (let i = 0; ; i++) {
    if (child.exitCode !== null) throw new Error(`fixture server exited:\n${output}`);
    try { if ((await request(port + 1, "/auth/check")).status === 200) break; } catch {}
    if (i > 300) throw new Error(`fixture server did not start:\n${output}`);
    await pause(50);
  }
  const login = await request(fixture.bridge, "/auth/login", "POST", JSON.stringify({ password: PASS }),
    { Origin: fixture.origin });
  assert.equal(login.status, 200, login.text);
  fixture.login = login;
  fixture.value = login.cookies[0].split(";")[0].slice(NAME.length + 1);
  fixture.cookie = { Cookie: `${NAME}=${fixture.value}` };
});

after(async () => {
  if (!fixture) return;
  if (fixture.child.exitCode === null) { fixture.child.kill("SIGTERM"); await once(fixture.child, "exit"); }
  fs.rmSync(fixture.outer, { recursive: true, force: true });
});

// first, before the later tests turn a /m open away inside the same five seconds
test("a turned-away request writes one line, with the facts and no secrets", async () => {
  const before = refusals().lines.length;
  const headers = { "Sec-Fetch-Site": "none", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document", "User-Agent": PHONE };
  assert.equal((await request(fixture.bridge, "/m", "GET", null, headers)).status, 200);
  const unknown = `${NAME}=${"1".repeat(64)}`;
  assert.equal((await request(fixture.bridge, "/state?secret=1", "GET", null,
    { Cookie: `theme=dark; ${unknown}`, "Sec-Fetch-Site": "cross-site", "User-Agent": DESKTOP })).status, 401);
  assert.equal((await request(fixture.bridge, "/uploads/IMG_private.png", "GET", null, {})).status, 401);
  assert.equal((await request(fixture.bridge, "/m/state", "GET", null, fixture.cookie)).status, 200);
  assert.equal((await request(fixture.bridge, "/m", "GET", null, { ...fixture.cookie, "Sec-Fetch-Site": "cross-site" })).status, 200);
  const { lines, text } = refusals();
  const fresh = lines.slice(before);
  assert.equal(fresh.length, 3, "one line per turned-away request, none for signed-in ones");
  const [noCookie, wrongCookie, file] = fresh;
  assert.deepEqual({ ...noCookie, ts: 0 }, { ts: 0, level: "info", kind: "signinrefused", method: "GET", route: "/m",
    cookie_header: false, cookies: 0, session_cookie: false, session_known: false,
    sec_fetch_site: "none", sec_fetch_mode: "navigate", sec_fetch_dest: "document", client: "phone" });
  assert.deepEqual({ ...wrongCookie, ts: 0 }, { ts: 0, level: "info", kind: "signinrefused", method: "GET", route: "/state",
    cookie_header: true, cookies: 2, session_cookie: true, session_known: false,
    sec_fetch_site: "cross-site", sec_fetch_mode: "absent", sec_fetch_dest: "absent", client: "chrome" });
  assert.equal(file.route, "/uploads/*");
  assert.equal(file.cookie_header, false);
  assert.equal(file.client, "other");
  for (const secret of [fixture.value, PASS, "1".repeat(64), "IMG_private", "secret=1", "iPhone", "Macintosh", "Mozilla", "theme"])
    assert.equal(text.includes(secret), false, `the log holds ${secret.slice(0, 6)}`);
});

test("sign-in and sign-out set the cookie SameSite=Lax, keeping the other attributes", async () => {
  assert.equal(fixture.login.cookies.length, 1);
  assert.equal(fixture.login.cookies[0],
    `${NAME}=${fixture.value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=315360000`);
  const other = await request(fixture.bridge, "/auth/login", "POST", JSON.stringify({ password: PASS }),
    { Origin: fixture.origin });
  const second = other.cookies[0].split(";")[0];
  const out = await request(fixture.bridge, "/auth/logout", "POST", null, { Origin: fixture.origin, Cookie: second });
  assert.equal(out.status, 200);
  assert.deepEqual(out.cookies, [`${NAME}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`]);
  assert.equal(sessions(), 1, "the extra session was not removed by its own sign-out");
});

test("a signed-in /m open sends the same session again as Lax; polls and other routes do not", async () => {
  const before = sessions();
  for (let n = 0; n < 2; n++) {
    const open = await request(fixture.bridge, "/m?box=x", "GET", null, fixture.cookie);
    assert.equal(open.status, 200);
    assert.deepEqual(open.cookies,
      [`${NAME}=${fixture.value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=315360000`], `open ${n}`);
  }
  for (const route of ["/m/state", "/state", "/m-sw.js", "/auth/check", "/push/key"]) {
    const answer = await request(fixture.bridge, route, "GET", null, fixture.cookie);
    assert.deepEqual(answer.cookies, [], `${route} sent a cookie`);
  }
  assert.equal(sessions(), before, "a page open made or removed a session");
  assert.equal(sessions(), 1);
  assert.equal((await request(fixture.bridge, "/state", "GET", null, fixture.cookie)).status, 200,
    "the same value stopped working");
  const turnedAway = await request(fixture.bridge, "/m", "GET", null, { Cookie: `${NAME}=${"0".repeat(64)}` });
  assert.deepEqual(turnedAway.cookies, [], "a page open without a session was given a cookie");
  assert.deepEqual((await request(fixture.bridge, "/m")).cookies, []);
});

test("a cross-origin write is refused with the Lax cookie present, and changes nothing", async () => {
  const boxes = async () => JSON.parse((await request(fixture.bridge, "/state", "GET", null, fixture.cookie)).text).boxes.length;
  const start = await boxes();
  const foreign = [
    { Origin: "https://other.example" },
    { Origin: "https://other.example", "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "cors" },
    { Origin: `http://127.0.0.1:${fixture.port}` },
    { Origin: "null" },
    {},
  ];
  for (const extra of foreign) {
    for (const route of ["/create", "/send?box=x", "/delete?box=x", "/close?box=x", "/auth/logout"]) {
      const answer = await request(fixture.bridge, route, "POST", "fixture", { ...fixture.cookie, ...extra });
      assert.equal(answer.status, 403, `${route} ${JSON.stringify(extra)}`);
      assert.match(answer.text, /origin refused/);
    }
  }
  assert.equal(await boxes(), start, "a refused write still changed the board");
  assert.equal((await request(fixture.bridge, "/state", "GET", null, fixture.cookie)).status, 200,
    "a refused cross-origin sign-out ended the session");
  const own = await request(fixture.bridge, "/create", "POST", "fixture", { ...fixture.cookie, Origin: fixture.origin });
  assert.equal(own.status, 200, own.text);
  assert.equal(await boxes(), start + 1);
});

test("a burst of turned-away polls writes one line, and the next window says how many were left out", async () => {
  const route = "/m/state";
  const count = () => refusals().lines.filter(line => line.route === route);
  const before = count().length;
  for (let n = 0; n < 30; n++) assert.equal((await request(fixture.bridge, route, "GET", null, {})).status, 401);
  const burst = count().slice(before);
  assert.equal(burst.length, 1);
  assert.equal(burst[0].folded, undefined);
  await pause(5300);
  assert.equal((await request(fixture.bridge, route, "GET", null, {})).status, 401);
  const next = count().slice(before);
  assert.equal(next.length, 2);
  assert.equal(next[1].folded, 29);
  assert.equal((await request(fixture.bridge, "/auth/check", "GET", null, {})).status, 200, "the gate stopped answering");
});
