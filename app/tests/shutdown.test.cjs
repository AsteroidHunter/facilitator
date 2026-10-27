// Settings' Shut down Facilitator on the Mac board, at the server: POST
// /shutdown from the board's own window (its cookie and its own origin) answers
// {"ok": true}, writes shutdown reason=board and starts facilitator stop, which
// ends the board and frees both of its ports, asking Chrome nothing. Anything
// else is refused and the board keeps running: no cookie, the agent key with
// or without the page's headers, another origin, the phone's door and a
// request Tailscale Serve forwarded. Each board is a locked fixture copy on a
// free pair of ports with its own data folder and the command beside it
// (shutdown-fixture.cjs), so nothing here reaches Chrome, Tailscale or port
// 8877. No browser is started.
const assert = require("node:assert/strict");
const { after, test } = require("node:test");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const fixture = require("./shutdown-fixture.cjs");
const { raw, key, page, cookieOf, canBind, events, called } = fixture;

const made = [];
after(async () => { for (const board of made) await board.end(); });
async function shutdownBoard() {
  const board = await fixture.shutdownBoard();
  made.push(board);
  return board;
}

async function stillRunning(board, why) {
  assert.equal(board.child.exitCode, null, `${why}: the board ended`);
  const st = await raw(board, "GET", "/state", { headers: key(board) });
  assert.equal(st.status, 200, `${why}: the board does not answer`);
  assert.equal(await canBind(board.port), false, `${why}: the board let go of its port`);
  assert.equal(await canBind(board.port + 1), false, `${why}: the board let go of the phone's port`);
}

test("POST /shutdown from the board's own window stops it, frees both ports and asks Chrome nothing", async () => {
  const board = await shutdownBoard();
  const cookie = await cookieOf(board);
  const pid = board.child.pid;
  const r = await raw(board, "POST", "/shutdown", { headers: { ...page(board), Cookie: cookie } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(JSON.parse(r.text), { ok: true });
  // the stop the board started ends it within the stop's own wait
  const deadline = Date.now() + 15000;
  while (board.child.exitCode === null && board.child.signalCode === null && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 50));
  assert.notEqual(board.child.exitCode === null && board.child.signalCode === null, true,
    `the board is still running (pid ${pid})`);
  for (let i = 0; i < 40 && !(await canBind(board.port + 1)); i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(await canBind(board.port), true, "the board's port is still held");
  assert.equal(await canBind(board.port + 1), true, "the phone's port is still held");
  const answered = await fetch(`${board.origin}/state`).then(() => true, () => false);
  assert.equal(answered, false, "the board still answers");
  const said = (await events(board)).filter(e => e.kind === "shutdown");
  assert.deepEqual(said.map(e => [e.level, e.reason]), [["info", "board"]], JSON.stringify(said));
  // the command looked at no window, and never at Chrome
  assert.deepEqual((await called(board)).filter(c => c.startsWith("osascript")), []);
  const saved = JSON.parse(await readFile(path.join(board.data, "state.json"), "utf8"));
  assert.equal(saved.title, "fixture board", "the stop lost the saved board");
});

test("POST /shutdown is refused to all but the board's own window, and the board keeps running", async () => {
  const board = await shutdownBoard();
  const cookie = await cookieOf(board);
  const asked = [
    // no key and no cookie: the lock's 401, whatever the headers say
    ["no cookie", {}, 401],
    ["no cookie, the page's headers", page(board), 401],
    // the agent key: refused as curl sends it and with the page's headers made up
    ["the agent key", key(board), 403],
    ["the agent key with the page's origin", { ...key(board), ...page(board) }, 403],
    // the window's cookie on a request that does not name the page's own origin
    ["the cookie with no origin", { Cookie: cookie }, 403],
    ["the cookie with another origin", { Cookie: cookie, Origin: "http://localhost:" + board.port,
                                         "Sec-Fetch-Site": "same-site" }, 403],
    ["the cookie from another site", { Cookie: cookie, Origin: "https://example.com", "Sec-Fetch-Site": "cross-site" }, 403],
    // Tailscale Serve's forwarding on the board's own port is the phone's door
    ["forwarded by Tailscale Serve", { ...key(board), ...page(board), Cookie: cookie, "X-Forwarded-For": "100.64.0.9" }, 404],
  ];
  for (const [why, headers, status] of asked) {
    const r = await raw(board, "POST", "/shutdown", { headers });
    assert.equal(r.status, status, `${why}: ${r.text}`);
    await stillRunning(board, why);
  }
  // the phone's own port, signed in or not, never reaches the route
  const phone = await raw(board, "POST", "/shutdown", { port: board.port + 1,
    headers: { Host: `127.0.0.1:${board.port + 1}`, Origin: `http://127.0.0.1:${board.port + 1}`,
               "Sec-Fetch-Site": "same-origin" } });
  assert.equal(phone.status, 404, phone.text);
  await stillRunning(board, "the phone's door");
  // nothing was started: no shutdown line, and after the stop's own wait the board is still there
  await new Promise(resolve => setTimeout(resolve, 1500));
  await stillRunning(board, "a moment later");
  assert.deepEqual((await events(board)).filter(e => e.kind === "shutdown"), []);
  assert.deepEqual(await called(board).then(c => c.filter(line => line.startsWith("osascript"))), []);
});
