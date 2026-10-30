// The board's own port answers its own window and agents with its key, and
// nobody else: another account on the Mac, or a sandboxed program allowed to
// connect out, reaches 127.0.0.1 as easily as the owner. A call with neither
// the agent key nor the window's cookie is refused with a 401 before any route
// sees it (a page open of / or /m gets the page saying to open the board with
// facilitator run), whatever browser headers it makes up; /unread alone
// answers. The key works, the cookie works, a launch code works once, ends,
// sets the cookie and sends the window on to /, and only Chrome ever gets one:
// the board opens its own window and sends its own tabs on, and no route
// answers with a code. A board page the lock refuses
// opens itself again once, so the board's own page says what to do, rather
// than drawing the refusal as a reading. The phone's door is the bridge
// gate's and is not asked for either. One locked fixture board on a free pair
// of ports, plus a copy of the command beside it; the suite never touches 8877,
// starts no browser and opens no window: the board's open and osascript are
// stand-ins (stubWindow) that write down what they were given. Every card and
// message is invented.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { execFile } = require("node:child_process");
const { request } = require("node:http");
const { chmod, copyFile, readFile, readdir, rm, stat, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");
const vm = require("node:vm");
const { ROOT, startBoard } = require("./board-fixture.cjs");
const { windowOpens, windowSends } = require("./fixture-auth.cjs");

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

// every launch code the board has given Chrome so far, through the stand-in
// open and osascript, in the order given
function codesGiven() {
  const addresses = [...windowOpens(board.windowDir).map(argv => argv.find(a => a.startsWith("--app=")).slice(6)),
                     ...windowSends(board.windowDir).map(([, , , goal]) => goal)];
  return addresses.map(a => new URL(a).searchParams.get("launch")).filter(Boolean);
}

// the board opens its window, as facilitator run asks it to, and the code it
// gave Chrome comes back from the stand-in open, as Chrome would open it
async function launchCode() {
  const before = windowOpens(board.windowDir).length;
  const r = await raw("POST", "/window/open", { headers: key() });
  assert.deepEqual([r.status, json(r)], [200, { opened: true }], r.text);
  const opens = windowOpens(board.windowDir);
  assert.equal(opens.length, before + 1, "the board did not open one window");
  return new URL(opens.at(-1).find(a => a.startsWith("--app=")).slice(6)).searchParams.get("launch");
}

// a window's cookie, got the way the window gets it
async function windowCookie() {
  const code = await launchCode();
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
    ["POST", "/remote/pair/new?name=lab"], ["GET", "/settings"], ["GET", "/sw.js"], ["POST", "/window/launch"],
    ["POST", "/window/open"], ["POST", "/window/relaunch", JSON.stringify({ tabs: [[1, 1, `${board.origin}/`]] })]];
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
  assert.deepEqual([windowOpens(board.windowDir), windowSends(board.windowDir)], [[], []],
    "a caller without the key opened a window or sent a tab on");
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
  // the cookie alone opens no window and sends no tab on
  const opens = windowOpens(board.windowDir).length, sends = windowSends(board.windowDir).length;
  for (const route of ["/window/open", "/window/relaunch", "/window/launch"])
    assert.equal((await raw("POST", route, { headers: { ...page(), Cookie: cookie } })).status, 401, route);
  assert.deepEqual([windowOpens(board.windowDir).length, windowSends(board.windowDir).length], [opens, sends]);
});

// a page's own reading code, cut from its file between start and end and run
// in a vm against this board, with read set up by tail. Its asks carry the
// window cookie cookie() gives, if any; its opens and its tab's marks are kept
function pageCode(source, start, end, tail, cookie) {
  const block = source.slice(source.indexOf(start), source.indexOf(end));
  assert.ok(source.includes(start) && source.includes(end) && block.length > 200, `${start} was not found`);
  const opened = [], marks = new Map();
  const ctx = vm.createContext({
    MessageChannel,
    reportProblem() {},
    sessionStorage: { getItem: k => (marks.has(k) ? marks.get(k) : null), setItem: (k, v) => marks.set(k, String(v)),
                      removeItem: k => marks.delete(k) },
    location: { reload: () => opened.push("reload"), replace: to => opened.push(to) },
    async fetch(route) {
      const r = await raw("GET", route, { headers: { ...page(), ...(cookie() ? { Cookie: cookie() } : {}) } });
      return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => JSON.parse(r.text) };
    },
  });
  vm.runInContext(block + "\n" + tail, ctx);
  return { read: () => ctx.read(), opened, marks };
}

test("a window the lock refuses opens itself again once, and the refusal is never drawn as a reading", async () => {
  let cookie = "";
  const index = await readFile(path.join(ROOT, "index.html"), "utf8");
  const board = pageCode(index, "// ---- the board's reading, lean", "// ---- the board's reading ends",
                         "globalThis.read = () => readState();", () => cookie);
  // refused: thrown rather than handed on, and the page opens itself again
  // once; a second refusal before any good reading opens nothing
  await assert.rejects(board.read(), /the board's lock refused this window/);
  await assert.rejects(board.read(), /the board's lock refused this window/);
  assert.deepEqual(board.opened, ["reload"]);
  // a window with its cookie reads the board and lets the mark go, and never
  // opens itself again while its cookie is good
  cookie = await windowCookie();
  assert.equal((await board.read()).title, "fixture board");
  assert.equal((await board.read()).title, "fixture board");
  assert.equal(board.marks.size, 0, "a good reading kept the mark");
  assert.deepEqual(board.opened, ["reload"]);
  // so a later refusal opens it again, once
  cookie = "";
  await assert.rejects(board.read(), /the board's lock refused this window/);
  await assert.rejects(board.read(), /the board's lock refused this window/);
  assert.deepEqual(board.opened, ["reload", "reload"]);

  // the /page view goes to / rather than opening itself again, since an open
  // of /page gets the bare refusal and an open of / the board's own page
  const view = await readFile(path.join(ROOT, "page.html"), "utf8");
  assert.match(view, /state = await lockChecked\(await fetch\("\/state"\)\);/);
  const pageView = pageCode(view, "const LOCK_RELOAD_MARK", "let pollFails = 0;",
                            'globalThis.read = async () => lockChecked(await fetch("/state"));', () => cookie);
  await assert.rejects(pageView.read(), /the board's lock refused this window/);
  await assert.rejects(pageView.read(), /the board's lock refused this window/);
  assert.deepEqual(pageView.opened, ["/"]);
  const openedPage = await raw("GET", "/page", { headers: OPEN });
  assert.deepEqual([openedPage.status, json(openedPage)], [401, { error: REFUSAL }]);
  cookie = await windowCookie();
  assert.equal((await pageView.read()).title, "fixture board");
  assert.equal(pageView.marks.size, 0, "a good reading kept the mark");
  assert.deepEqual(pageView.opened, ["/"]);
});

test("a launch code works once, as a page, sets the cookie and sends the window on to /", async () => {
  const given = { code: await launchCode() };
  assert.match(given.code, /^[A-Za-z0-9_-]{32}$/);
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
  const fresh = { code: await launchCode() };
  const reopened = await raw("GET", `/?launch=${fresh.code}`, { headers: { ...OPEN, Cookie: parts[0] } });
  assert.deepEqual([reopened.status, reopened.headers["set-cookie"]], [303, undefined]);
  // a made-up code is no code
  assert.equal((await raw("GET", `/?launch=${"a".repeat(32)}`, { headers: OPEN })).status, 401);
});

test("a launch code sends the window on to its own query, a pulled-out project's, without any code", async () => {
  // a window without the cookie is let in and lands on its own project
  const code = await launchCode();
  const opened = await raw("GET", `/?project=pastureland&launch=${code}&x=1`, { headers: OPEN });
  assert.equal(opened.status, 303, opened.text);
  assert.equal(opened.headers.location, "/?project=pastureland&x=1");
  assert.ok(opened.headers["set-cookie"], "the window got no cookie");
  const cookie = opened.headers["set-cookie"][0].split(";")[0];
  // one that has the cookie lands there too, and a code spelt another way in
  // the address is still a code and is never sent on, so nothing loops
  const fresh = { code: await launchCode() };
  const kept = await raw("GET", `/?launch=${fresh.code}&project=pastureland&%6Caunch=${fresh.code}`,
    { headers: { ...OPEN, Cookie: cookie } });
  assert.deepEqual([kept.status, kept.headers.location, kept.headers["set-cookie"]],
    [303, "/?project=pastureland", undefined]);
  const landed = await raw("GET", kept.headers.location, { headers: { ...OPEN, Cookie: cookie } });
  assert.equal(landed.status, 200);
  assert.match(landed.text, /id="npversion"/);
});

test("a launch code ends after its life", async () => {
  const code = await launchCode();
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

// the address the stand-in open was last given, and its launch code
function lastOpen() {
  const argv = windowOpens(board.windowDir).at(-1);
  const app = new URL(argv.find(a => a.startsWith("--app=")).slice(6));
  return { argv, app, code: app.searchParams.get("launch") };
}
const setConfig = extra => writeFile(path.join(board.data, "run.config.json"),
  JSON.stringify({ port: board.port, lanes: [], ...extra }));

test("the board opens its own window: a chromeless app window on its page, with a code only Chrome gets", async () => {
  const r = await raw("POST", "/window/open", { headers: key() });
  assert.deepEqual([r.status, json(r)], [200, { opened: true }]);
  assert.equal(r.text.includes(lastOpen().code), false, "the answer held the code");
  const { argv, app, code } = lastOpen();
  assert.deepEqual(argv, ["-na", "Google Chrome", "--args", `--app=${board.origin}/?launch=${code}`]);
  assert.equal(app.pathname, "/");
  assert.match(code, /^[A-Za-z0-9_-]{32}$/);
  // the page the command names, in its own loopback spelling, with its query
  const named = await raw("POST", "/window/open", { headers: key(), body: `http://localhost:${board.port}` });
  assert.equal(named.status, 200, named.text);
  assert.equal(lastOpen().argv[3], `--app=http://localhost:${board.port}/?launch=${lastOpen().code}`);
  // and nothing but this board's own page on this Mac
  const count = windowOpens(board.windowDir).length;
  for (const page of ["https://example.com/", `http://127.0.0.1:${board.port + 1}/`, `http://127.0.0.1:${board.port}/m`,
                      `https://127.0.0.1:${board.port}/`, `http://evil.example:${board.port}/`, "not a page"]) {
    const refused = await raw("POST", "/window/open", { headers: key(), body: page });
    assert.equal(refused.status, 400, page);
  }
  assert.equal(windowOpens(board.windowDir).length, count, "a page not the board's was opened");
});

test("the board's window opens full screen when run.config.json says app_fullscreen true, and only then", async () => {
  try {
    await setConfig({ app_fullscreen: true });
    assert.equal((await raw("POST", "/window/open", { headers: key() })).status, 200);
    assert.deepEqual(lastOpen().argv.slice(-2), [`--app=${board.origin}/?launch=${lastOpen().code}`, "--start-fullscreen"]);
    for (const value of [false, "true", 1, null]) {
      await setConfig({ app_fullscreen: value });
      assert.equal((await raw("POST", "/window/open", { headers: key() })).status, 200);
      assert.equal(lastOpen().argv.length, 4, `app_fullscreen ${JSON.stringify(value)} changed the launch`);
    }
  } finally {
    await setConfig({});
  }
});

test("a window Chrome would not open is passed back with what open said, for the command's one line", async () => {
  const fails = path.join(board.windowDir, "open-fails");
  await writeFile(fails, "Unable to find application named 'Google Chrome'\nmore\n");
  try {
    const r = await raw("POST", "/window/open", { headers: key() });
    assert.deepEqual([r.status, json(r)],
      [502, { error: "could not open Chrome", said: "Unable to find application named 'Google Chrome'" }]);
  } finally {
    await rm(fails, { force: true });
  }
});

test("a relaunch sends each board tab, where it is, to its own page with a code of its own", async () => {
  const before = windowSends(board.windowDir).length;
  const own = `${board.origin}/`;
  const pulled = `${board.origin}/?project=pastureland&launch=SPENT&%6Caunch=SPENT2#box-3`;
  const r = await raw("POST", "/window/relaunch", { headers: key(), body: JSON.stringify({ tabs: [
    [7, 2, own], [7, 3, pulled], [8, 1, "https://example.com/"], [8, 2, `http://127.0.0.1:${board.port + 1}/`]] }) });
  assert.deepEqual([r.status, json(r)], [200, { sent: ["SENT", "SENT", null, null] }]);
  const sends = windowSends(board.windowDir).slice(before);
  assert.deepEqual(sends.map(([wid, place, expected]) => [wid, place, expected]), [["7", "2", own], ["7", "3", pulled]],
    "a tab not the board's was sent on, or the board's own was not");
  const [first, second] = sends.map(([, , , goal]) => new URL(goal));
  assert.equal(first.href, `${own}?launch=${first.searchParams.get("launch")}`);
  assert.equal(second.href,
    `${board.origin}/?project=pastureland&launch=${second.searchParams.get("launch")}#box-3`,
    "the tab's own query and place were not kept, or an old code was kept");
  assert.notEqual(first.searchParams.get("launch"), second.searchParams.get("launch"), "two tabs shared a code");
  for (const goal of [first, second]) assert.equal(r.text.includes(goal.searchParams.get("launch")), false);
  // each one lets its window in
  const opened = await raw("GET", second.pathname + second.search, { headers: OPEN });
  assert.deepEqual([opened.status, opened.headers.location], [303, "/?project=pastureland"]);
  assert.ok(opened.headers["set-cookie"], "the code sent on set no cookie");
  // what Chrome answers comes back as it is, and a body that is not tabs is refused
  const answer = path.join(board.windowDir, "send-answer");
  await writeFile(answer, "GONE\n");
  try {
    const gone = await raw("POST", "/window/relaunch", { headers: key(), body: JSON.stringify({ tabs: [[7, 2, own]] }) });
    assert.deepEqual(json(gone), { sent: ["GONE"] });
  } finally {
    await rm(answer, { force: true });
  }
  for (const body of ["", "[]", '{"tabs": [[0, 1, "x"]]}', '{"tabs": [["7", 1, "x"]]}', '{"tabs": [[7, 1]]}'])
    assert.equal((await raw("POST", "/window/relaunch", { headers: key(), body })).status, 400, body);
});

test("no route answers with a launch code: the old one says so, and nothing the board serves holds one", async () => {
  const old = await raw("POST", "/window/launch", { headers: key() });
  assert.equal(old.status, 410);
  assert.deepEqual(Object.keys(json(old)), ["error"]);
  assert.equal(windowOpens(board.windowDir).length + windowSends(board.windowDir).length > 0, true);
  // codes still good, and some spent, are in the board's memory now; none of
  // them is in any answer to a reading of any route, nor in the board's log
  await launchCode();
  await raw("POST", "/window/relaunch", { headers: key(), body: JSON.stringify({ tabs: [[9, 1, `${board.origin}/`]] }) });
  const codes = codesGiven();
  assert.ok(codes.length >= 10, `only ${codes.length} codes were given`);
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const reads = [...source.matchAll(/Route\("(\/[^"{]*)", [^\n]*methods=\[[^\]]*"GET"/g)].map(m => m[1])
    .filter(route => !["/wait", "/events"].includes(route));
  assert.ok(reads.length > 40, `only ${reads.length} routes were read`);
  const cookie = await windowCookie();
  for (const route of reads) {
    for (const headers of [key(), { ...page(), Cookie: cookie }]) {
      const r = await Promise.race([raw("GET", route, { headers }),
                                    new Promise(resolve => setTimeout(() => resolve({ text: "" }), 3000))]);
      for (const code of codes) assert.equal(r.text.includes(code), false, `GET ${route} answered with a code`);
    }
  }
  for (const route of ["/window/open", "/window/relaunch", "/window/launch"]) {
    const r = await raw("POST", route, { headers: key(), body: route === "/window/relaunch"
      ? JSON.stringify({ tabs: [[9, 1, `${board.origin}/`]] }) : "" });
    for (const code of codesGiven()) assert.equal(r.text.includes(code), false, `POST ${route} answered with a code`);
  }
  const logged = (await Promise.all((await readdir(board.logs)).map(n => readFile(path.join(board.logs, n), "utf8")))).join("");
  for (const code of codesGiven()) assert.equal(logged.includes(code), false, "a launch code was written to the log");
  // the one place a code is made is the one that puts it in an address for Chrome
  assert.deepEqual([...source.matchAll(/_new_launch\(\)/g)].length, 2, "a code is made somewhere new");
  assert.match(source, /def _with_launch\(page: str\) -> str:[^]*?"launch=" \+ _new_launch\(\)/);
});

// the command, through this board: what it asks the board and what it runs
function commandWith(code) {
  return cli([
    "ran = []",
    "class Done:",
    "    returncode = 0",
    "    stderr = ''",
    "cli.subprocess.run = lambda command, **kw: ran.append(command) or Done()",
    // whether this Mac lets the command control Chrome decides only the step
    // that brings Chrome forward (cli-quiet.test.cjs), never what is opened
    "cli.chrome_allowed = lambda: False",
    code,
  ].join("\n"));
}

test("the command has the board open its window, and opens any other page itself, with no code", async () => {
  const before = windowOpens(board.windowDir).length;
  const { stdout } = await commandWith([
    `cli.open_app({'port': ${board.port}}, False)`,
    `cli.open_app({'port': ${board.port}, 'app_url': 'https://board.example.com/'}, False)`,
    "print(json.dumps(ran))",
  ].join("\n"));
  // the board's own page: the board opened it, and the command ran nothing
  assert.equal(windowOpens(board.windowDir).length, before + 1);
  const { argv, code } = lastOpen();
  assert.deepEqual(argv, ["-na", "Google Chrome", "--args", `--app=${board.origin}/?launch=${code}`]);
  // another page than this board's is opened by the command as it is
  assert.deepEqual(JSON.parse(stdout.trim()), [["open", "-na", "Google Chrome", "--args", "--app=https://board.example.com/"]]);
  const opened = await raw("GET", `/?launch=${code}`, { headers: OPEN });
  assert.equal(opened.status, 303);
  assert.ok(opened.headers["set-cookie"][0].startsWith(`${cookieName()}=`));
});

test("a window the board could not open is the command's same one line", async () => {
  const fails = path.join(board.windowDir, "open-fails");
  await writeFile(fails, "Unable to find application named 'Google Chrome'\n");
  try {
    const { stdout } = await commandWith([`cli.open_app({'port': ${board.port}}, False)`, "print(json.dumps(ran))"].join("\n"));
    assert.deepEqual(stdout.trim().split("\n"), [
      `could not open Chrome (Unable to find application named 'Google Chrome'); open http://127.0.0.1:${board.port} yourself`,
      "[]"]);
  } finally {
    await rm(fails, { force: true });
  }
});

test("the command reads Chrome's tabs and the board sends the ones showing it on, so no code reaches the command", async () => {
  const before = windowSends(board.windowDir).length;
  const { stdout } = await commandWith([
    `cli.chrome_tabs = lambda: [(7, ["chrome://newtab/", "${board.origin}/?project=pastureland"]), (8, ["https://example.com/"])]`,
    "asked = []",
    "real = cli.board_window",
    "cli.board_window = lambda *a: asked.append(a[1]) or real(*a)",
    `found = cli.relaunch_board_tabs({'port': ${board.port}})`,
    "cli.chrome_tabs = lambda: None",
    `unknown = cli.relaunch_board_tabs({'port': ${board.port}})`,
    "cli.chrome_tabs = lambda: [(8, ['https://example.com/'])]",
    `none = cli.relaunch_board_tabs({'port': ${board.port}})`,
    "print(json.dumps({'found': found, 'unknown': unknown, 'none': none, 'asked': asked, 'ran': ran}))",
  ].join("\n"));
  const got = JSON.parse(stdout.trim());
  assert.deepEqual(got, { found: 1, unknown: null, none: 0, asked: ["/window/relaunch"], ran: [] });
  const sends = windowSends(board.windowDir).slice(before);
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0].slice(0, 3), ["7", "2", `${board.origin}/?project=pastureland`]);
  assert.match(sends[0][3], new RegExp(`^${board.origin}/\\?project=pastureland&launch=[A-Za-z0-9_-]{32}$`));
});
