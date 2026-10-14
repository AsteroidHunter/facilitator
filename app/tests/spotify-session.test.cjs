// The Spotify sign-in kept on the board's disk, so a board that moved to
// another port needs no new sign-in. It is a secret, and the phone reaches the
// board through the guarded port with a signed-in session, so the one route
// that holds it answers only a page on the Mac itself: never through the phone
// port however signed in, never through Tailscale's forwarding, never to a
// foreign Host or a cross-site fetch, and a write must name its own origin.
// And it never rides along in /state, /settings or /board-settings.js.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const box = require("./board-sandbox.cjs");

const PASS = "correct-horse-7!";
const NAME = "__Host-facilitator_session";
const SIGN_IN = { access: "AT-secret-0001", refresh: "RT-secret-0002", expires: "1790000000000",
                  scopes: "user-read-playback-state" };
let place, port, local, cookie;

function request(onPort, route, method = "GET", body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const bytes = body == null ? null : Buffer.from(body);
    const req = http.request({ hostname: "127.0.0.1", port: onPort, path: route, method,
      headers: { ...(bytes ? { "content-length": bytes.length } : {}), ...headers } }, res => {
      const parts = [];
      res.on("data", part => parts.push(part));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers,
        text: Buffer.concat(parts).toString() }));
    });
    req.on("error", reject);
    req.end(bytes);
  });
}

before(async () => {
  port = await box.freePortPair();
  place = box.sandbox("spotify-session", { config: { port } });
  execFileSync(box.PYTHON, ["-c", `import bridge_auth; bridge_auth.set_password(${JSON.stringify(PASS)})`],
               { cwd: place.app });
  await box.waitReady(box.launch(place), port);
  local = { Origin: `http://127.0.0.1:${port}` };
  const phoneOrigin = `http://127.0.0.1:${port + 1}`;
  const login = await request(port + 1, "/auth/login", "POST", JSON.stringify({ password: PASS }), { Origin: phoneOrigin });
  assert.equal(login.status, 200, login.text);
  cookie = { Cookie: login.headers["set-cookie"][0].split(";")[0], Origin: phoneOrigin };
  assert.ok(cookie.Cookie.startsWith(NAME + "="));
});

after(async () => { if (place) await box.cleanup(place); });

test("a local page keeps the sign-in and reads it back, and the copy lands only once", async () => {
  assert.deepEqual(JSON.parse((await request(port, "/spotify/session")).text), {});
  const saved = await request(port, "/spotify/session", "POST", JSON.stringify(SIGN_IN), local);
  assert.equal(saved.status, 200, saved.text);
  assert.deepEqual(JSON.parse((await request(port, "/spotify/session")).text), SIGN_IN);
  const again = await request(port, "/spotify/session?seed=1", "POST",
                              JSON.stringify({ ...SIGN_IN, refresh: "RT-another-browser" }), local);
  assert.equal(JSON.parse(again.text).seeded, false);
  assert.deepEqual(JSON.parse((await request(port, "/spotify/session")).text), SIGN_IN);
  const file = path.join(place.app, "settings.json");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, "the file holding a sign-in is readable by others");
  for (const body of [{ access: "x", password: "y" }, { access: 7 }, ["access"], { refresh: "x".repeat(4097) }]) {
    const res = await request(port, "/spotify/session", "POST", JSON.stringify(body), local);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60));
  }
  assert.deepEqual(JSON.parse((await request(port, "/spotify/session")).text), SIGN_IN);
});

test("the sign-in never rides in the state, the settings or the settings file served to pages", async () => {
  await request(port, "/spotify/session", "POST", JSON.stringify(SIGN_IN), local);
  await fetch(`http://127.0.0.1:${port}/settings`, { method: "POST", body: JSON.stringify({ bgcolor: "#eeeeee" }) });
  const seen = [
    (await request(port, "/state")).text,
    (await request(port, "/settings")).text,
    (await request(port, "/board-settings.js")).text,
    (await request(port, "/m/state")).text,
    (await request(port + 1, "/state", "GET", null, cookie)).text,
    (await request(port + 1, "/m/state", "GET", null, cookie)).text,
    (await request(port + 1, "/settings", "GET", null, cookie)).text,
  ];
  for (const text of seen)
    for (const secret of [SIGN_IN.access, SIGN_IN.refresh]) assert.ok(!text.includes(secret), text.slice(0, 120));
  const logs = fs.readdirSync(place.logs).map(name => fs.readFileSync(path.join(place.logs, name), "utf8")).join("\n");
  for (const secret of [SIGN_IN.access, SIGN_IN.refresh]) assert.ok(!logs.includes(secret), "a sign-in reached the log");
});

test("a signed-in phone cannot read or write it, and neither can anything but a local page", async () => {
  await request(port, "/spotify/session", "POST", JSON.stringify(SIGN_IN), local);
  // the phone's own port, signed in: the gate turns it away before the board
  const phoneRead = await request(port + 1, "/spotify/session", "GET", null, cookie);
  assert.equal(phoneRead.status, 404);
  assert.ok(!phoneRead.text.includes(SIGN_IN.refresh));
  const phoneWrite = await request(port + 1, "/spotify/session", "POST", JSON.stringify({ access: "planted" }), cookie);
  assert.equal(phoneWrite.status, 404);
  // the local port reached through Tailscale Serve carries its forwarding header
  for (const header of [{ "X-Forwarded-For": "100.64.0.9" }, { "Tailscale-Headers-Info": "x" }]) {
    const res = await request(port, "/spotify/session", "GET", null, { ...cookie, ...header });
    assert.equal(res.status, 404, JSON.stringify(header));
  }
  // a name some other site resolves to this machine, and a fetch another site set off:
  // the board's outer guard refuses both before the route is asked
  for (const header of [{ Host: `evil.example:${port}` }, { "Sec-Fetch-Site": "cross-site" }]) {
    const res = await request(port, "/spotify/session", "GET", null, header);
    assert.equal(res.status, 403, JSON.stringify(header));
    assert.ok(!res.text.includes(SIGN_IN.refresh));
  }
  // a write has to name its own origin
  assert.equal((await request(port, "/spotify/session", "POST", JSON.stringify({ access: "planted" }))).status, 403);
  assert.equal((await request(port, "/spotify/session", "POST", JSON.stringify({ access: "planted" }),
                              { Origin: "http://evil.example" })).status, 403);
  assert.deepEqual(JSON.parse((await request(port, "/spotify/session")).text), SIGN_IN, "a refused write changed it");
  // localhost is the same Mac, and is answered
  assert.equal((await request(port, "/spotify/session", "GET", null, { Host: `localhost:${port}` })).status, 200);
});
