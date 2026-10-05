// No other website can show the board's pages inside its own. Every answer
// the board gives forbids being framed except local /m by the identical origin;
// the files a picture or upload is served as keep the exact sandbox they had.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { request } = require("node:http");
const { startBoard } = require("./board-fixture.cjs");

let board;

function call(method, route, headers = {}, body, port = board.port) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path: route,
      headers: { Host: `127.0.0.1:${board.port}`, ...headers } }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, raw: res.rawHeaders,
        text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"), Buffer.alloc(4096, 7)]);
const headerCount = (response, name) => response.raw.filter((word, i) => i % 2 === 0 && word.toLowerCase() === name).length;

before(async () => { board = await startBoard(); });
after(async () => { if (board) await board.stop(); });

test("every other answer on the board's port forbids being framed", async () => {
  const sent = await call("POST", "/upload?name=picture.png", {}, PNG);
  assert.equal(sent.status, 200, sent.text);
  const url = JSON.parse(sent.text).url;
  const refused = { Origin: "http://evil.example", "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "cors" };
  const routes = [
    ["/", {}], ["/state", {}], ["/limits", {}], ["/thread?box=0", {}], ["/settings", {}],
    ["/sw.js", {}], ["/manifest.json", {}], ["/card-logic.js", {}], [url, {}],
    ["/no-such-route", {}], ["/state", refused], ["/", { Host: "evil.example" }],
  ];
  for (const [route, headers] of routes) {
    const response = await call("GET", route, headers);
    assert.equal(headerCount(response, "x-frame-options"), 1, `${route} ${response.status}`);
    assert.equal(response.headers["x-frame-options"], "DENY", `${route} ${response.status}`);
    const policy = response.headers["content-security-policy"];
    assert.ok(policy !== undefined, `${route} has a content security policy`);
    assert.equal(headerCount(response, "content-security-policy"), 1, `${route}: one policy, not two`);
    if (route === url) assert.equal(policy, "sandbox", "an upload keeps its sandbox exactly");
    else assert.match(policy, /(^|;\s*)frame-ancestors 'none'(;|$)/, route);
  }
  const written = await call("POST", "/send?box=0", {}, "framed or not");
  assert.equal(written.status, 200);
  assert.equal(written.headers["x-frame-options"], "DENY");
});

test("the real phone page works without sign-in locally and permits only same-origin ancestors", async () => {
  for (const route of ["/m", "/m?mac=1"]) {
    const response = await call("GET", route, {
      Origin: board.origin, "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Dest": "iframe",
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers["x-frame-options"], "SAMEORIGIN");
    assert.equal(response.headers["content-security-policy"], "frame-ancestors 'self'");
    assert.equal(headerCount(response, "x-frame-options"), 1);
    assert.equal(headerCount(response, "content-security-policy"), 1);
    assert.ok(response.text.includes('id="dock"'), "the phone app, not the sign-in gate");
  }
  const asset = await call("GET", "/mac-phone-view.js");
  assert.equal(asset.status, 200);
  assert.match(asset.headers["content-type"], /javascript/);
  assert.ok(asset.text.includes("root.MacPhoneView"));
  assert.equal(asset.headers["x-frame-options"], "DENY");
});

test("foreign and forwarded phone requests cannot gain the local framing exception", async () => {
  for (const headers of [
    { Origin: "https://other.example", "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Dest": "iframe" },
    { Host: "other.example" },
    { Host: "board.example.ts.net", "X-Forwarded-For": "100.64.0.9" },
    { Host: "board.example.ts.net", "Tailscale-Headers-Info": "1" },
  ]) {
    const response = await call("GET", "/m?mac=1", headers);
    assert.equal(response.headers["x-frame-options"], "DENY");
    assert.ok(!/frame-ancestors 'self'/.test(response.headers["content-security-policy"]));
  }
});

test("the phone's port and what the gate itself answers forbid it too", async () => {
  const onPhonePort = { Host: "board.example.ts.net" };
  const phone = await call("GET", "/m", onPhonePort, undefined, board.port + 1);
  assert.equal(phone.status, 200);
  assert.equal(phone.headers["x-frame-options"], "DENY");
  assert.equal(headerCount(phone, "content-security-policy"), 1);
  const closed = await call("GET", "/state", { ...onPhonePort, "X-Forwarded-For": "100.64.0.9" });
  assert.equal(closed.status, 401);
  assert.equal(closed.headers["x-frame-options"], "DENY");
  assert.equal(headerCount(closed, "x-frame-options"), 1);
  // the gate's own policy is the gate's: it is not rewritten, and not doubled
  assert.equal(headerCount(closed, "content-security-policy"), 1);
  assert.match(closed.headers["content-security-policy"], /default-src 'self'/);
  const login = await call("GET", "/auth/session", onPhonePort, undefined, board.port + 1);
  assert.equal(login.headers["x-frame-options"], "DENY");
});
