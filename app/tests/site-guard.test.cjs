// No other website can make the desktop board do anything. The board's own
// port answers the board's own page and any caller that is not a browser (an
// agent's curl sends no Origin and no fetch metadata); it refuses what a page
// from another site, or a name another site pointed at this Mac, sent. One
// fixture board on a free pair of ports; the suite never touches 8877.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { request } = require("node:http");
const { readFile, readdir } = require("node:fs/promises");
const path = require("node:path");
const { startBoard } = require("./board-fixture.cjs");

let board;
let own;

function call(method, route, headers = {}, body, port = board.port) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path: route,
      headers: { Host: `127.0.0.1:${board.port}`, ...headers } }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers,
        text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

// what Chrome sends for the board's own page talking to the board
const SAME = { Origin: "", "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty" };
// what it sends for a page on another site
const evil = (extra = {}) => ({ Origin: "http://evil.example", "Sec-Fetch-Site": "cross-site",
  "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty", ...extra });

async function lines() {
  const out = [];
  for (const name of (await readdir(board.logs)).sort())
    for (const line of (await readFile(path.join(board.logs, name), "utf8")).split("\n"))
      if (line !== "") out.push(JSON.parse(line));
  return out;
}

async function thread() {
  return (await call("GET", "/thread?box=0")).text;
}

before(async () => {
  board = await startBoard();
  own = `http://127.0.0.1:${board.port}`;
  SAME.Origin = own;
});

after(async () => { if (board) await board.stop(); });

test("the board's own page and a call with no browser in it still get through", async () => {
  const page = await call("GET", "/", { "Sec-Fetch-Site": "none", "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Dest": "document", "Sec-Fetch-User": "?1" });
  assert.equal(page.status, 200);
  assert.match(page.headers["content-type"], /text\/html/);

  assert.equal((await call("GET", "/state", SAME)).status, 200);
  const sent = await call("POST", "/send?box=0", SAME, "from the board's own page");
  assert.equal(sent.status, 200, sent.text);
  assert.equal((await call("GET", "/settings", SAME)).status, 200);
  assert.equal((await call("GET", "/push/key", SAME)).status !== 403, true);
  assert.equal((await call("POST", "/clientlog", SAME, "")).status, 400, "the client log route is reached, not refused");
  assert.equal((await call("GET", "/state", { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "no-cors",
    "Sec-Fetch-Dest": "image" })).status, 200, "a picture or file the page asks for");

  // curl and onboard.py: no Origin, no fetch metadata
  assert.equal((await call("GET", "/state", { "User-Agent": "curl/8.7.1" })).status, 200);
  const curled = await call("POST", "/send?box=0", { "User-Agent": "curl/8.7.1" }, "from an agent");
  assert.equal(curled.status, 200, curled.text);
  assert.equal((await call("GET", "/unread?owner=facilitator")).status, 200);
  assert.match(await thread(), /from an agent/);

  // the same board reached by its other loopback name
  assert.equal((await call("GET", "/state", { Host: `localhost:${board.port}` })).status, 200);
});

test("the push, notification-log, settings and script routes of the board's own page get through, and another site's calls to them do not", async () => {
  const script = { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Dest": "script" };
  const served = await call("GET", "/board-settings.js", script);
  assert.equal(served.status, 200);
  assert.match(served.headers["content-type"], /javascript/);
  const stolen = await call("GET", "/board-settings.js", { ...script, "Sec-Fetch-Site": "cross-site" });
  assert.equal(stolen.status, 403, "another site's script tag cannot read the board's settings");

  // the chime's mute is a board setting, written by the page with a plain fetch
  const wrote = await call("POST", "/settings", SAME, JSON.stringify({ chimemuted: "1" }));
  assert.equal(wrote.status, 200, wrote.text);
  assert.equal(JSON.parse((await call("GET", "/settings", SAME)).text).values.chimemuted, "1");
  assert.equal((await call("POST", "/settings", evil(), JSON.stringify({ chimemuted: "0" }))).status, 403);
  assert.equal(JSON.parse((await call("GET", "/settings", SAME)).text).values.chimemuted, "1",
    "another site changed the mute");

  // the phone page and its worker report a push and the notification state to the client log
  const notices = JSON.stringify({ page: "phone", client: "phone", reports: [
    { kind: "pushreceived", outcome: "shown", ms: 41, status: 200, ago: 3, n: 7, worker: "facilitator-m-7" },
    { kind: "notifycheck", source: "start", perm: "granted", reg: true, sub: "no" },
    { kind: "notifylost", source: "return", reg: true },
  ] });
  const logged = await call("POST", "/clientlog", SAME, notices);
  assert.equal(logged.status, 200, logged.text);
  assert.equal(JSON.parse(logged.text).written, 3);
  assert.equal((await call("POST", "/clientlog", evil(), notices)).status, 403);

  // a phone link is stored and taken away by the page; another site cannot do either
  const link = JSON.stringify({ endpoint: "https://push.example/endpoint-one", keys: { p256dh: "a", auth: "b" } });
  assert.equal((await call("POST", "/push/subscribe", evil(), link)).status, 403);
  const stored = await call("POST", "/push/subscribe", SAME, link);
  assert.equal(stored.status, 200, stored.text);
  assert.equal((await call("POST", "/push/unsubscribe", evil(), link)).status, 403);
  assert.equal((await call("POST", "/push/unsubscribe", SAME, link)).status, 200);

  // what facilitator stop, restart and status read: no browser, so no Origin and no fetch metadata
  const reader = { "User-Agent": "Python-urllib/3.14" };
  assert.equal((await call("GET", "/state", reader)).status, 200);
});

test("a page from another website is refused, whatever it asks for, and changes nothing", async () => {
  const phrase = "marmalade-quarry-4417";
  const cases = [
    ["a fetch with CORS", "POST", "/send?box=0", evil()],
    ["a request that skips the CORS check", "POST", "/send?box=0", evil({ "Sec-Fetch-Mode": "no-cors" })],
    ["a form post", "POST", "/send?box=0", evil({ "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" })],
    ["a browser with no fetch metadata", "POST", "/send?box=0", { Origin: "http://evil.example" }],
    ["an origin that is null", "POST", "/send?box=0", { Origin: "null" }],
    ["another port on the same name", "POST", "/send?box=0",
      { Origin: "http://localhost:3000", "Sec-Fetch-Site": "same-site", "Sec-Fetch-Mode": "cors" }],
    ["the board's own address on the wrong scheme", "POST", "/send?box=0",
      { Origin: `https://127.0.0.1:${board.port}`, "Sec-Fetch-Site": "cross-site" }],
  ];
  for (const [name, method, route, headers] of cases) {
    const response = await call(method, route, headers, phrase);
    assert.equal(response.status, 403, name);
    assert.deepEqual(JSON.parse(response.text), { error: "request from another site refused" }, name);
    assert.ok(!response.text.includes(phrase), name);
  }
  assert.ok(!(await thread()).includes(phrase), "a refused request reached the card");

  // reads: an image tag, a script tag, a prefetch, and a link opening something that is not a page
  for (const route of ["/state", "/settings", "/log", "/thread?box=0", "/limits", "/spotify/session", "/uploads/none.png"]) {
    for (const headers of [
      { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Dest": "image" },
      { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Dest": "script" },
      { "Sec-Fetch-Site": "same-site", "Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Dest": "image" },
      { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" },
      { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "iframe" },
    ]) {
      assert.equal((await call("GET", route, headers)).status, 403, `${route} ${JSON.stringify(headers)}`);
    }
  }
  const upload = await call("POST", "/upload?name=x.png", evil(), "not a picture");
  assert.equal(upload.status, 403);
  const note = await call("POST", "/settings", evil(), "{}");
  assert.equal(note.status, 403);
});

test("a name another site pointed at this Mac is not the board", async () => {
  for (const host of [`evil.example:${board.port}`, `127.0.0.1.evil.example:${board.port}`,
    `localhost.evil.example:${board.port}`, `evil.example`, `127.0.0.1:${board.port + 5}`]) {
    // a page loaded through the rebound name is same-origin with itself, and says so
    const read = await call("GET", "/state", { Host: host, "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors" });
    assert.equal(read.status, 403, host);
    const bare = await call("GET", "/state", { Host: host });
    assert.equal(bare.status, 403, host);
    const written = await call("POST", "/send?box=0", { Host: host, Origin: "http://" + host,
      "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors" }, "rebound");
    assert.equal(written.status, 403, host);
    const page = await call("GET", "/", { Host: host, "Sec-Fetch-Site": "none", "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Dest": "document" });
    assert.equal(page.status, 403, `${host}: the page itself`);
    // adding Serve's forwarding header does not turn it into the phone: the gate wants a sign-in
    const forwarded = await call("GET", "/state", { Host: host, "X-Forwarded-For": "100.64.0.9",
      "Sec-Fetch-Site": "same-origin" });
    assert.ok([401, 403].includes(forwarded.status), `${host}: forwarded ${forwarded.status}`);
  }
  assert.ok(!(await thread()).includes("rebound"));
});

test("a link from another site may open the board's page, which is how Spotify comes back, and nothing else", async () => {
  const arrives = { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document",
    "Sec-Fetch-User": "?1" };
  const back = await call("GET", "/?code=abc&state=xyz", arrives);
  assert.equal(back.status, 200);
  assert.match(back.headers["content-type"], /text\/html/);
  assert.equal((await call("GET", "/m", arrives)).status, 200);
  // the board's own service worker hands the same opening on with an empty destination
  const handedOn = { ...arrives, "Sec-Fetch-Dest": "empty" };
  assert.equal((await call("GET", "/?code=abc&state=xyz", handedOn)).status, 200);
  assert.equal((await call("GET", "/state", handedOn)).status, 403);
  assert.equal((await call("GET", "/", { ...handedOn, "Sec-Fetch-Mode": "cors" })).status, 403,
    "a script's fetch of the page is not an opening");
  assert.equal((await call("GET", "/", { ...handedOn, "Sec-Fetch-Mode": "no-cors" })).status, 403);
  assert.equal((await call("GET", "/?code=abc", { ...arrives, "Sec-Fetch-Dest": "iframe" })).status, 403,
    "the page inside another site's frame is not an opening");
  assert.equal((await call("POST", "/", { ...arrives, Origin: "https://accounts.spotify.com" }, "")).status, 403);
  assert.equal((await call("GET", "/state", arrives)).status, 403);
  assert.equal((await call("GET", "/spotify/session", arrives)).status, 403);
  // the sign-in itself still works from the page, and is still the page's alone
  const kept = await call("POST", "/spotify/session", SAME, JSON.stringify({
    access: "a", refresh: "r", expires: "1", scopes: "s" }));
  assert.equal(kept.status, 200, kept.text);
  assert.equal(JSON.parse((await call("GET", "/spotify/session", SAME)).text).refresh, "r");
});

test("what reaches the board through the phone's gate is still the gate's to decide", async () => {
  const forwarded = { "X-Forwarded-For": "100.64.0.9", Host: "board.example.ts.net" };
  const closed = await call("GET", "/state", forwarded);
  assert.equal(closed.status, 401);
  assert.deepEqual(JSON.parse(closed.text), { error: "sign in required" });
  const phone = await call("GET", "/m", { Host: "board.example.ts.net", "Sec-Fetch-Site": "cross-site",
    "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" }, undefined, board.port + 1);
  assert.equal(phone.status, 200);
  assert.match(phone.text, /Sign in to Facilitator/);
  const login = await call("POST", "/auth/login", { Host: "board.example.ts.net", Origin: "https://evil.example" },
    "{}", board.port + 1);
  assert.equal(login.status, 403);
  assert.deepEqual(JSON.parse(login.text), { error: "origin refused" }, "the gate's own word, not the board's");
});

test("a refusal is written once per window, names the route and the reason, and keeps no part of the request", async () => {
  const phrase = "gelatin-sextant-9921";
  for (let i = 0; i < 12; i++)
    assert.equal((await call("POST", `/context?box=0&note=${phrase}`, evil(), phrase)).status, 403);
  await call("GET", "/limits", { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "no-cors" });
  const all = await lines();
  const sent = all.filter(line => line.kind === "refusal" && line.route === "/context");
  assert.ok(sent.length >= 1 && sent.length <= 2, `${sent.length} lines for twelve refusals`);
  assert.equal(sent[0].level, "info");
  assert.equal(sent[0].code, 403);
  assert.equal(typeof sent[0].reason, "string");
  assert.ok(sent[0].reason.length > 0);
  assert.ok(all.some(line => line.kind === "refusal" && line.route === "/limits"), "another route has its own line");
  for (const line of all) assert.ok(!JSON.stringify(line).includes(phrase), "a refused request reached the log");
  assert.ok(!all.some(line => line.kind === "refusal" && JSON.stringify(line).includes("evil.example")),
    "the other site's name is not written down");
});
