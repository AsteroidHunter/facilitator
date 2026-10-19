// Who may use the folder picker's routes (/machines, /dirs, /mkdir): the
// board's own page and a caller with no browser in it on the board's own
// port, and a signed-in phone through its door, writing only from its own
// page. Another website, a name another site pointed at this Mac, and a phone
// that has not signed in get nothing, make nothing, and leave no folder name
// in the log. One copied board on a free pair of ports, with HOME set to a
// made-up folder, so no real folder is listed or made; 8877 is never touched.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { request } = require("node:http");
const path = require("node:path");
const { startBoard } = require("./board-fixture.cjs");

const PYTHON = process.env.FACILITATOR_TEST_PYTHON || "python3";
const PASS = "Tp" + crypto.randomBytes(8).toString("hex") + "9!";
const COOKIE = "__Host-facilitator_session";
// the made-up home's name and a folder in it: neither may reach the log
const HOME_NAME = "quill-home-7731";
const INSIDE = "lantern-notes";
const REFUSED = { error: "request from another site refused" };
let board, home, own, phone, signedIn;

function call(port, method, route, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path: route, headers }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers,
        text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}
// the board's own port, as Chrome sends for the board's own page unless told otherwise
const local = (method, route, headers = {}) => call(board.port, method, route,
  { Host: `127.0.0.1:${board.port}`, Origin: own, "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty", ...headers });
// the phone's door, signed in unless the cookie is taken out
const door = (method, route, headers = {}) => call(board.port + 1, method, route,
  { Host: `127.0.0.1:${board.port + 1}`, Cookie: signedIn, ...headers });
const mkdir = name => "/mkdir?" + new URLSearchParams({ path: home, name });
const dirs = (p = "~") => "/dirs?" + new URLSearchParams({ path: p });
const folders = () => fs.readdirSync(home).sort();

before(async () => {
  const env = {};
  board = await startBoard({
    env,
    prepare: ({ app, outer }) => {
      fs.mkdirSync(path.join(outer, HOME_NAME, INSIDE), { recursive: true });
      env.HOME = path.join(outer, HOME_NAME);
      execFileSync(PYTHON, ["-c", `import bridge_auth; bridge_auth.set_password(${JSON.stringify(PASS)})`], { cwd: app });
    },
  });
  home = fs.realpathSync(path.join(board.outer, HOME_NAME));
  own = `http://127.0.0.1:${board.port}`;
  phone = `http://127.0.0.1:${board.port + 1}`;
  const login = await call(board.port + 1, "POST", "/auth/login",
    { Host: `127.0.0.1:${board.port + 1}`, Origin: phone, "Content-Type": "application/json" }, JSON.stringify({ password: PASS }));
  assert.equal(login.status, 200, login.text);
  signedIn = [].concat(login.headers["set-cookie"])[0].split(";")[0];
  assert.ok(signedIn.startsWith(COOKIE + "="));
});

after(async () => { if (board) await board.stop(); });

test("the board's own page lists and makes folders in home, and so may a caller with no browser", async () => {
  const machines = await local("GET", "/machines");
  assert.equal(machines.status, 200, machines.text);
  assert.equal(JSON.parse(machines.text).machines[0].top, home);
  const listed = await local("GET", dirs());
  assert.equal(listed.status, 200, listed.text);
  assert.deepEqual(JSON.parse(listed.text).dirs.map(d => d.name), [INSIDE]);
  const madeHere = await local("POST", mkdir("from-the-page"));
  assert.equal(madeHere.status, 200, madeHere.text);
  // curl and the agents: no Origin, no fetch metadata
  const curled = await call(board.port, "GET", dirs(), { Host: `127.0.0.1:${board.port}`, "User-Agent": "curl/8.7.1" });
  assert.equal(curled.status, 200, curled.text);
  assert.deepEqual(folders(), ["from-the-page", INSIDE]);
});

test("a page on another website can neither list nor make folders, whatever it sends", async () => {
  const before = folders();
  const senders = [
    ["a fetch with CORS", { Origin: "http://evil.example", "Sec-Fetch-Site": "cross-site" }],
    ["a request that skips the CORS check", { Origin: "http://evil.example", "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "no-cors" }],
    ["a picture or a script tag", { Origin: undefined, "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Dest": "image" }],
    ["a form", { Origin: "http://evil.example", "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" }],
    ["a browser with no fetch metadata", { Origin: "http://evil.example", "Sec-Fetch-Site": undefined, "Sec-Fetch-Mode": undefined, "Sec-Fetch-Dest": undefined }],
    ["an origin that is null", { Origin: "null", "Sec-Fetch-Site": "cross-site" }],
    ["another port on this Mac", { Origin: "http://localhost:3000", "Sec-Fetch-Site": "same-site" }],
    ["the board's address on the wrong scheme", { Origin: `https://127.0.0.1:${board.port}`, "Sec-Fetch-Site": "cross-site" }],
    ["the phone's own door as an origin", { Origin: phone, "Sec-Fetch-Site": "same-site" }],
  ];
  for (const [name, extra] of senders) {
    const headers = Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined));
    const strip = Object.keys(extra).filter(k => extra[k] === undefined);
    for (const [method, route] of [["GET", "/machines"], ["GET", dirs()], ["GET", dirs("/")], ["POST", mkdir("from-another-site")]]) {
      const base = { Host: `127.0.0.1:${board.port}`, Origin: own, "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty" };
      for (const k of strip) delete base[k];
      const answer = await call(board.port, method, route, { ...base, ...headers });
      assert.equal(answer.status, 403, `${name}: ${method} ${route}`);
      assert.deepEqual(JSON.parse(answer.text), REFUSED, `${name}: ${method} ${route}`);
      assert.ok(!answer.text.includes(HOME_NAME) && !answer.text.includes(INSIDE), `${name}: the answer names a folder`);
    }
  }
  assert.deepEqual(folders(), before, "a refused request made a folder");
});

test("a name another site pointed at this Mac gets nothing from the picker's routes", async () => {
  const before = folders();
  for (const host of [`evil.example:${board.port}`, `127.0.0.1.evil.example:${board.port}`, "evil.example",
    `127.0.0.1:${board.port + 5}`]) {
    // a page loaded through the rebound name is same-origin with itself, and says so
    const rebound = { Host: host, Origin: "http://" + host, "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors" };
    for (const [method, route] of [["GET", "/machines"], ["GET", dirs()], ["POST", mkdir("rebound")]]) {
      const answer = await call(board.port, method, route, rebound);
      assert.equal(answer.status, 403, `${host}: ${method} ${route}`);
      assert.ok(!answer.text.includes(HOME_NAME), host);
    }
  }
  assert.deepEqual(folders(), before);
});

test("through the phone's door: nothing without a sign-in, and a signed-in phone writes only from its own page", async () => {
  const before = folders();
  for (const [method, route, headers] of [["GET", "/machines", {}], ["GET", dirs(), {}],
    ["POST", mkdir("unsigned"), { Origin: phone }]]) {
    const answer = await door(method, route, { ...headers, Cookie: "" });
    assert.equal(answer.status, 401, `${method} ${route}`);
    assert.deepEqual(JSON.parse(answer.text), { error: "sign in required" });
    // Serve's forwarding header on the board's own port is the phone's door too
    const served = await call(board.port, method, route, { Host: "board.example.ts.net", "X-Forwarded-For": "100.64.0.9", ...headers });
    assert.equal(served.status, 401, `forwarded ${method} ${route}`);
  }
  for (const origin of ["https://evil.example", own, "null", undefined]) {
    const answer = await door("POST", mkdir("cross-origin"), origin === undefined ? {} : { Origin: origin });
    assert.equal(answer.status, 403, `origin ${origin}`);
    assert.deepEqual(JSON.parse(answer.text), { error: "origin refused" });
  }
  for (const route of ["/machines", dirs()]) {
    const answer = await door("GET", route, { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "no-cors" });
    assert.equal(answer.status, 403, route);
    assert.ok(!answer.text.includes(HOME_NAME));
  }
  assert.deepEqual(folders(), before, "a refused request made a folder");
  // signed in, from its own page: the drop lists home and makes a folder there
  const listed = await door("GET", dirs(), { "Sec-Fetch-Site": "same-origin" });
  assert.equal(listed.status, 200, listed.text);
  assert.equal(JSON.parse(listed.text).path, home);
  const madeThere = await door("POST", mkdir("from-the-phone"), { Origin: phone });
  assert.equal(madeThere.status, 200, madeThere.text);
  assert.ok(folders().includes("from-the-phone"));
  // and still nothing outside home
  assert.deepEqual(JSON.parse((await door("GET", dirs("/"), { "Sec-Fetch-Site": "same-origin" })).text),
    { error: "outside the home folder" });
});

test("the log names routes and reasons, never a folder, a path or the home folder's name", async () => {
  const lines = [];
  for (const name of fs.readdirSync(board.logs))
    for (const line of fs.readFileSync(path.join(board.logs, name), "utf8").split("\n"))
      if (line) lines.push(line);
  assert.ok(lines.some(line => line.includes('"refusal"')), "no refusal was written down, so this proves nothing");
  for (const word of [HOME_NAME, INSIDE, "from-the-page", "from-the-phone", "from-another-site", "rebound", "unsigned",
    "cross-origin", "path="])
    assert.ok(!lines.some(line => line.includes(word)), `the log holds ${word}`);
});
