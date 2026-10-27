// The board's own port answers its own window and agents with its key, and
// nobody else: another account on the Mac, or a sandboxed program allowed to
// connect out, reaches 127.0.0.1 as easily as the owner. A call with neither
// the agent key nor the window's cookie is refused with a 401 before any route
// sees it (a page open of / or /m gets the page saying to open the board with
// facilitator run), whatever browser headers it makes up; /unread alone
// answers. The key works, the cookie works, a launch code works once, ends,
// sets the cookie and sends the window on to /. The phone's door is the bridge
// gate's and is not asked for either. One locked fixture board on a free pair
// of ports, plus a copy of the command beside it; the suite never touches 8877,
// starts no browser and opens no window. Every card and message is invented.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { execFile } = require("node:child_process");
const { request } = require("node:http");
const { chmod, copyFile, readFile, readdir, stat, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");
const { ROOT, startBoard } = require("./board-fixture.cjs");

const execFileAsync = promisify(execFile);
const LIFE = 2;   // seconds a launch code lives in this copy, so its end can be waited for
let board;

before(async () => {
  board = await startBoard({ lock: true, prepare: async ({ app }) => {
    const file = path.join(app, "server.py");
    const source = await readFile(file, "utf8");
    const patched = source.replace("LAUNCH_LIFE = 60.0", `LAUNCH_LIFE = ${LIFE}.0`);
    assert.notEqual(patched, source, "the launch code's life was not patched");
    await writeFile(file, patched);
  } });
  await copyFile(path.join(ROOT, "facilitator"), path.join(board.app, "facilitator"));
  await copyFile(path.join(ROOT, "data_folder.py"), path.join(board.app, "data_folder.py"));
  await writeFile(path.join(board.data, "run.config.json"), JSON.stringify({ port: board.port, lanes: [] }));
});
after(async () => { if (board) await board.stop(); });

// one request on a port with exactly these headers and no others
function raw(method, route, { body, headers = {}, port = board.port } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path: route,
      headers: { Host: `127.0.0.1:${port}`, ...headers } }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers,
        text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}
const json = r => JSON.parse(r.text);
const key = () => ({ Authorization: `Bearer ${board.key()}` });
const cookieName = () => `facilitator_window_${board.port}`;
// what Chrome sends for the window's page opening, and for a script on it
const OPEN = { "Sec-Fetch-Site": "none", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" };
const page = () => ({ Origin: board.origin, "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors",
                      "Sec-Fetch-Dest": "empty" });
const REFUSAL = "this board answers only its own window and agents that carry its key: "
  + "run scripts/onboard.py inspect and put -K and the file it names in front of every curl";

async function launchCode() {
  const r = await raw("POST", "/window/launch", { headers: key() });
  assert.equal(r.status, 200, r.text);
  return json(r);
}

// a window's cookie, got the way the window gets it
async function windowCookie() {
  const { code } = await launchCode();
  const opened = await raw("GET", `/?launch=${code}`, { headers: OPEN });
  assert.equal(opened.status, 303, opened.text);
  const set = opened.headers["set-cookie"];
  assert.ok(set && set.length === 1, "no cookie was set");
  return set[0].split(";")[0];
}

test("the key files are for this account alone and carry the key for curl", async () => {
  const keyText = await readFile(path.join(board.data, "agent.key"), "utf8");
  assert.match(keyText, /^[A-Za-z0-9_-]{43}\n$/);
  const curl = await readFile(path.join(board.data, "agent.curl"), "utf8");
  assert.equal(curl, `header = "Authorization: Bearer ${keyText.trim()}"\nnoproxy = "*"\n`);
  for (const name of ["agent.key", "agent.curl"])
    assert.equal((await stat(path.join(board.data, name))).mode & 0o777, 0o600, name);
  assert.equal((await stat(board.data)).mode & 0o777, 0o700);
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  assert.match(source, /^LAUNCH_LIFE = 60\.0 /m, "a launch code lives 60 seconds on a real board");
});

test("no key and no cookie is a 401 on every route, and the route never runs", async () => {
  const asked = [["GET", "/state"], ["GET", "/thread?box=1.1"], ["POST", "/send?box=1.1", "from another account"],
    ["POST", "/navsave?lane=pastureland&path=a.md", "overwritten"], ["GET", "/dirs?path=~"],
    ["POST", "/remote/pair/new?name=lab"], ["GET", "/settings"], ["GET", "/sw.js"], ["POST", "/window/launch"]];
  for (const [method, route, body] of asked) {
    for (const headers of [{}, { "User-Agent": "curl/8.7.1" }, page(), OPEN]) {
      const r = await raw(method, route, { body, headers });
      assert.equal(r.status, 401, `${method} ${route} ${JSON.stringify(headers)}: ${r.text}`);
      assert.deepEqual(json(r), { error: REFUSAL });
      assert.equal(r.headers["cache-control"], "no-store");
    }
  }
  // a key that is not the board's, and the key as some other scheme, are no key
  for (const headers of [{ Authorization: "Bearer " + "x".repeat(43) }, { Authorization: `Basic ${board.key()}` },
                         { Cookie: `${cookieName()}=made-up` }])
    assert.equal((await raw("GET", "/state", { headers })).status, 401, JSON.stringify(headers));
  const thread = json(await raw("GET", "/thread?box=1.1", { headers: key() }));
  assert.equal(JSON.stringify(thread).includes("from another account"), false, "a refused send was stored");
  const logged = (await Promise.all((await readdir(board.logs)).filter(n => n.startsWith("server-"))
    .map(n => readFile(path.join(board.logs, n), "utf8")))).join("");
  assert.match(logged, /"reason": ?"no key or window cookie"/);
  assert.equal(logged.includes(board.key()), false, "the key was written to the log");
});

test("a page open of / or /m without the cookie gets the page saying to open it with facilitator run", async () => {
  for (const route of ["/", "/m", "/?code=abc"]) {
    const r = await raw("GET", route, { headers: OPEN });
    assert.equal(r.status, 401, route);
    assert.match(r.headers["content-type"], /^text\/html/);
    assert.match(r.text, /Open the board with facilitator run/);
    assert.doesNotMatch(r.text, /<script>/, "a page opened from this Mac opens itself again");
    assert.doesNotMatch(r.text, /Standing meta card|fixture board/, "the board's own page leaked");
    assert.equal(r.headers["x-frame-options"], "DENY");
  }
  // one another site sent here, as the Spotify sign-in comes back, opens
  // itself once from its own address, which carries a SameSite=Strict cookie
  const back = await raw("GET", "/?code=abc", { headers: { ...OPEN, "Sec-Fetch-Site": "cross-site" } });
  assert.equal(back.status, 401);
  assert.match(back.text, /<script>location\.replace\(location\.href\)<\/script>/);
});

test("the agent key opens every route, and what it sends is an agent's", async () => {
  const st = await raw("GET", "/state", { headers: key() });
  assert.equal(st.status, 200);
  assert.equal(json(st).title, "fixture board");
  const sent = await raw("POST", "/send?box=1.1", { body: "sent with the key", headers: key() });
  assert.equal(sent.status, 200, sent.text);
  const keyedPage = await raw("POST", "/send?box=1.1", { body: "the key with page headers", headers: { ...key(), ...page() } });
  assert.equal(keyedPage.status, 200, keyedPage.text);
  const box = json(await raw("GET", "/state", { headers: key() })).boxes.find(b => b.id === "1.1");
  assert.deepEqual(box.pendingBy.slice(-2), ["agent", "agent"]);
  assert.equal((await raw("GET", "/fresh?owner=pastureland", { headers: key() })).status, 200);
  // and the agent-only routes still refuse the window
  const cookie = await windowCookie();
  assert.equal((await raw("GET", "/fresh?owner=pastureland", { headers: { Cookie: cookie, ...page() } })).status, 403);
});

test("the window's cookie opens the board, and what the window sends is the person's", async () => {
  const cookie = await windowCookie();
  const opened = await raw("GET", "/", { headers: { ...OPEN, Cookie: cookie } });
  assert.equal(opened.status, 200);
  assert.match(opened.text, /<link rel="manifest"/);
  const phoneView = await raw("GET", "/m", { headers: { ...OPEN, "Sec-Fetch-Dest": "iframe", "Sec-Fetch-Site": "same-origin",
                                                       Cookie: cookie } });
  assert.deepEqual([phoneView.status, phoneView.headers["x-frame-options"]], [200, "SAMEORIGIN"],
                   "the Mac board's phone view cannot frame the phone page");
  assert.equal((await raw("GET", "/state", { headers: { ...page(), Cookie: cookie } })).status, 200);
  // a cookie another program on 127.0.0.1 left beside it does not hide it
  const crowded = `odd="{[not, a cookie]}"; other=1; ${cookie}`;
  assert.equal((await raw("GET", "/state", { headers: { ...page(), Cookie: crowded } })).status, 200);
  const said = await raw("POST", "/send?box=1.1", { body: "typed in the window", headers: { ...page(), Cookie: cookie } });
  assert.equal(said.status, 200, said.text);
  const box = json(await raw("GET", "/state", { headers: key() })).boxes.find(b => b.id === "1.1");
  assert.equal(box.pendingBy.at(-1), null, "the window's message was not stored as the person's");
  // the cookie alone does not mint launch codes
  assert.equal((await raw("POST", "/window/launch", { headers: { ...page(), Cookie: cookie } })).status, 401);
});

test("a launch code works once, as a page, sets the cookie and sends the window on to /", async () => {
  const given = await launchCode();
  assert.match(given.code, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(given.seconds, LIFE);
  // fetched by a script rather than opened as a page, it is not spent
  const fetched = await raw("GET", `/?launch=${given.code}`, { headers: page() });
  assert.equal(fetched.status, 401);
  assert.equal(fetched.headers["set-cookie"], undefined);
  const opened = await raw("GET", `/?launch=${given.code}`, { headers: OPEN });
  assert.equal(opened.status, 303);
  assert.equal(opened.headers.location, "/");
  const [set] = opened.headers["set-cookie"];
  const parts = set.split(";").map(s => s.trim());
  assert.match(parts[0], new RegExp(`^${cookieName()}=[A-Za-z0-9_-]{43}$`));
  for (const part of ["Path=/", "HttpOnly", "SameSite=Strict"]) assert.ok(parts.includes(part), `${part} in ${set}`);
  assert.ok(parts.some(p => /^Max-Age=\d{8,}$/.test(p)), set);
  // the board keeps the cookie's hash, never the cookie, for this account alone
  const keys = await readFile(path.join(board.data, "window-keys.json"), "utf8");
  assert.equal(keys.includes(parts[0].split("=")[1]), false, "the cookie itself was kept");
  assert.match(keys, /"hash": "[0-9a-f]{64}"/);
  assert.equal((await stat(path.join(board.data, "window-keys.json"))).mode & 0o777, 0o600);
  // the same code a second time is spent
  const again = await raw("GET", `/?launch=${given.code}`, { headers: OPEN });
  assert.equal(again.status, 401);
  assert.match(again.text, /Open the board with facilitator run/);
  assert.equal(again.headers["set-cookie"], undefined);
  // a window that already has its cookie keeps it, and a dead code in its address goes
  const kept = await raw("GET", `/?launch=${given.code}`, { headers: { ...OPEN, Cookie: parts[0] } });
  assert.deepEqual([kept.status, kept.headers.location, kept.headers["set-cookie"]], [303, "/", undefined]);
  const fresh = await launchCode();
  const reopened = await raw("GET", `/?launch=${fresh.code}`, { headers: { ...OPEN, Cookie: parts[0] } });
  assert.deepEqual([reopened.status, reopened.headers["set-cookie"]], [303, undefined]);
  // a made-up code is no code
  assert.equal((await raw("GET", `/?launch=${"a".repeat(32)}`, { headers: OPEN })).status, 401);
});

test("a launch code ends after its life", async () => {
  const { code } = await launchCode();
  await new Promise(resolve => setTimeout(resolve, LIFE * 1000 + 300));
  const late = await raw("GET", `/?launch=${code}`, { headers: OPEN });
  assert.equal(late.status, 401);
  assert.equal(late.headers["set-cookie"], undefined);
});

test("/unread answers without the key, and reads only", async () => {
  const r = await raw("GET", "/unread?owner=pastureland");
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(Object.keys(json(r)).sort(), ["claimed", "queued"]);
  assert.equal((await raw("POST", "/unread?owner=pastureland")).status, 401);
});

test("the phone's door is the gate's: it asks for the phone's sign-in, not the key", async () => {
  const phone = await raw("GET", "/state", { port: board.port + 1 });
  assert.equal(phone.status, 401);
  assert.deepEqual(json(phone), { error: "sign in required" });
  const forwarded = await raw("GET", "/state", { headers: { ...key(), "X-Forwarded-For": "100.64.0.9" } });
  assert.deepEqual([forwarded.status, json(forwarded)], [401, { error: "sign in required" }]);
});

test("a restart keeps the key and the window's cookie, and puts back a loosened or edited key file", async () => {
  const before = board.key();
  const cookie = await windowCookie();
  await board.restart(async () => {
    await chmod(path.join(board.data, "agent.key"), 0o644);
    await writeFile(path.join(board.data, "agent.curl"), "edited\n");
  });
  assert.equal(board.key(), before);
  for (const name of ["agent.key", "agent.curl"])
    assert.equal((await stat(path.join(board.data, name))).mode & 0o777, 0o600, name);
  assert.equal(await readFile(path.join(board.data, "agent.curl"), "utf8"),
               `header = "Authorization: Bearer ${before}"\nnoproxy = "*"\n`);
  assert.equal((await raw("GET", "/state", { headers: { ...page(), Cookie: cookie } })).status, 200);
  assert.equal((await raw("GET", "/state", { headers: key() })).status, 200);
});

// the command, beside the board as on an install: what it asks the board
// carries the key, and the window it opens is opened on a launch code
function cli(code) {
  const where = path.join(board.app, "facilitator");
  return execFileAsync("python3", ["-c", [
    "import importlib.machinery, importlib.util, json",
    `loader = importlib.machinery.SourceFileLoader("facilitator_cli", ${JSON.stringify(where)})`,
    "spec = importlib.util.spec_from_loader(loader.name, loader)",
    "cli = importlib.util.module_from_spec(spec)",
    "loader.exec_module(cli)",
    code,
  ].join("\n")], { cwd: board.app, env: { ...process.env, FACILITATOR_LOG_DIR: path.join(board.outer, "cli-logs") },
                   timeout: 60000 });
}

test("the command's calls carry the key", async () => {
  const { stdout } = await cli([
    `st = cli.board_state(${board.port})`,
    "print(json.dumps({'title': st and st['title'], 'servers': cli.board_call('GET', '/remote/servers')[0]}))",
  ].join("\n"));
  assert.deepEqual(JSON.parse(stdout.trim()), { title: "fixture board", servers: 200 });
  const magic = await execFileAsync("python3", [path.join(board.app, "facilitator"), "magic", "0", "text", "from the command"],
    { env: { ...process.env, FACILITATOR_LOG_DIR: path.join(board.outer, "cli-logs") }, timeout: 60000 });
  assert.equal(JSON.parse(magic.stdout.trim()).ok, true);
  const body = json(await raw("GET", "/magic/body?box=0", { headers: key() }));
  assert.equal(body.text, "from the command");
  const status = await execFileAsync("python3", [path.join(board.app, "facilitator"), "status"],
    { env: { ...process.env, FACILITATOR_LOG_DIR: path.join(board.outer, "cli-logs") }, timeout: 60000 });
  assert.match(status.stdout, /^server up, \d+ boxes, \d+ queued/);
});

test("the command opens the window on a launch code that sets the window's cookie", async () => {
  const { stdout } = await cli([
    "opened = []",
    "class Done:",
    "    returncode = 0",
    "    stderr = ''",
    "cli.subprocess.run = lambda command, **kw: opened.append(command) or Done()",
    `cli.open_app({'port': ${board.port}}, False)`,
    `cli.open_app({'port': ${board.port}, 'app_url': 'https://board.example.com/'}, False)`,
    "print(json.dumps(opened))",
  ].join("\n"));
  const [mine, elsewhere] = JSON.parse(stdout.trim());
  assert.deepEqual(mine.slice(0, 4), ["open", "-na", "Google Chrome", "--args"]);
  const url = new URL(mine[4].replace(/^--app=/, ""));
  assert.equal(url.origin + url.pathname, `${board.origin}/`);
  const code = url.searchParams.get("launch");
  assert.match(code, /^[A-Za-z0-9_-]{32}$/);
  // another page than this board's is opened as it is, with no code
  assert.equal(elsewhere[4], "--app=https://board.example.com/");
  const opened = await raw("GET", `/?launch=${code}`, { headers: OPEN });
  assert.equal(opened.status, 303);
  assert.ok(opened.headers["set-cookie"][0].startsWith(`${cookieName()}=`));
});
