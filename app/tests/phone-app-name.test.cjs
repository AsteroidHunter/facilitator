// The name an iPhone suggests when the phone app is added to the Home Screen,
// proved without a browser.
//
// Safari's Add to Home Screen sheet takes its suggested name from the page's
// apple-mobile-web-app-title tag when there is one, else from the web app
// manifest, else from the page's title, and the icon keeps that name as its
// label. An icon is added either from the sign-in page (the gate) the bridge
// shows at /m to anyone signed out, or from the board page itself once signed
// in, and the board page rewrites its tag from the board's title on every
// reading. A board that was never given a title carries the tool's lowercase
// lane name, which the board keeps; as the app's name it is written
// Facilitator on every path, and a title the owner chose goes through as is.
//
// The server here is a real copy in a temp directory behind a fake Tailscale
// CLI, on ports the OS picks, and every request is plain HTTP. The board page's
// naming rule runs in node:vm against a stand-in tag. Nothing here opens a
// browser or touches port 8877, and the board is invented.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { execFileSync, spawn } = require("node:child_process");
const { once } = require("node:events");
const http = require("node:http");
const { chmod, copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const PASS = "AppNameFixture7!";
const COPIED = ["m.html", "m-sw.js", "m-manifest.json", "card-markdown.js", "card-tokens.css",
                "card-logic.js", "card-report.js", "compose-format.js", "index.html", "page.html",
                "manifest.json", "sw.js"];
const APP_NAME = "Facilitator";

let outer = "";
let app = "";
let port = 0;
let child = null;
let output = "";

// one request on its own socket: the board closes every connection with its
// answer, so nothing here is pooled
function request(onPort, route, headers = {}, method = "GET", body = null) {
  return new Promise((resolve, reject) => {
    const bytes = body == null ? null : Buffer.from(body);
    const req = http.request({
      host: "127.0.0.1", port: onPort, path: route, method, agent: false,
      headers: { ...(bytes ? { "content-length": bytes.length } : {}), ...headers },
    }, res => {
      const parts = [];
      res.on("data", part => parts.push(part));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers,
                                    text: Buffer.concat(parts).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(bytes);
  });
}

async function signIn() {
  const bridge = `http://127.0.0.1:${port + 1}`;
  const answer = await request(port + 1, "/auth/login",
    { Origin: bridge, "Content-Type": "application/json" }, "POST", JSON.stringify({ password: PASS }));
  assert.equal(answer.status, 200, answer.text);
  const cookie = (answer.headers["set-cookie"] || [])[0]?.split(";")[0];
  assert.ok(cookie, "the fixture sign-in issued no session");
  return cookie;
}

// the tag a page carries in its head, or null
function headTag(html, pattern) {
  const head = html.slice(0, html.indexOf("</head>"));
  const found = pattern.exec(head);
  return found ? found[1] : null;
}
const titleTagOf = html => headTag(html, /<meta name="apple-mobile-web-app-title" content="([^"]*)">/);

// the name Safari's sheet suggests: the tag, else the manifest, else the title
function suggestedName(titleTag, manifest, pageTitle) {
  if (titleTag && titleTag.trim()) return titleTag;
  if (manifest && (manifest.name || manifest.short_name)) return manifest.name || manifest.short_name;
  return pageTitle;
}

before(async () => {
  outer = await mkdtemp(path.join(tmpdir(), "facilitator-m874-app-name-"));
  app = path.join(outer, "app");
  const bin = path.join(outer, "bin");
  await mkdir(app);
  await mkdir(bin);
  // a Tailscale CLI with no Serve rules at all, first on the PATH, so the board
  // never asks the machine's own
  await writeFile(path.join(bin, "tailscale"), "#!/bin/sh\necho '{}'\n");
  await chmod(path.join(bin, "tailscale"), 0o755);
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])")
    .replace('TAILSCALE_APP = "/Applications/Tailscale.app/Contents/MacOS/Tailscale"',
             'TAILSCALE_APP = "/facilitator-test/no-tailscale-app"');
  assert.match(patched, /PORT = int\(os\.environ\['FACILITATOR_TEST_PORT'\]\)/, "the port was not patched");
  assert.match(patched, /TAILSCALE_APP = "\/facilitator-test\/no-tailscale-app"/,
    "the fixture could fall through to the real Tailscale app");
  await writeFile(path.join(app, "server.py"), patched);
  require("./fixture-auth.cjs").copyBridgeFiles(app);
  for (const name of COPIED) await copyFile(path.join(ROOT, name), path.join(app, name));
  await cp(path.join(ROOT, "assets"), path.join(app, "assets"), { recursive: true });
  // a seed with no title, so the board carries the default one, as a board
  // that was never named does
  await writeFile(path.join(app, "seed.json"), JSON.stringify({
    items: [{ id: "0", bucket: "meta", title: "An invented standing card", owner: "facilitator" }],
  }));
  const python = process.env.FACILITATOR_TEST_PYTHON ||
    execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
  execFileSync(python, ["-c", `import bridge_auth; bridge_auth.set_password(${JSON.stringify(PASS)})`],
    { cwd: app });
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
});

after(async () => {
  if (child && child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
  if (outer) await rm(outer, { recursive: true, force: true });
});

test("the board keeps its own lowercase title and lane", async () => {
  const state = JSON.parse((await request(port, "/state")).text);
  assert.equal(state.title, "facilitator", "the fixture board is not the untitled default");
  assert.equal(state.boxes.find(box => box.id === "0").owner, "facilitator");
});

test("the manifest names the app Facilitator on the bridge, signed out and signed in", async () => {
  for (const headers of [{}, { Cookie: await signIn() }]) {
    const served = await request(port + 1, "/m-manifest.json", headers);
    assert.equal(served.status, 200);
    const manifest = JSON.parse(served.text);
    assert.equal(manifest.name, APP_NAME);
    assert.equal(manifest.short_name, APP_NAME);
  }
});

test("the local manifest route names the untitled board Facilitator, and a chosen title as written", async () => {
  const manifest = JSON.parse((await request(port, "/m-manifest.json")).text);
  assert.equal(manifest.name, APP_NAME);
  assert.equal(manifest.short_name, APP_NAME);
  // the one exception, and nothing wider: run the server's own rule on titles
  // the owner could have chosen
  const python = process.env.FACILITATOR_TEST_PYTHON ||
    execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
  const names = JSON.parse(execFileSync(python, ["-c", [
    "import ast, json, pathlib",
    "tree = ast.parse(pathlib.Path('server.py').read_text())",
    "fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == '_app_name')",
    "scope = {}",
    "exec(compile(ast.Module([fn], []), 'server.py', 'exec'), scope)",
    "print(json.dumps([scope['_app_name'](t) for t in",
    "  ['facilitator', 'Facilitator', 'FACILITATOR', 'my board', 'iPhone notes']]))",
  ].join("\n")], { cwd: app, encoding: "utf8" }));
  assert.deepEqual(names, [APP_NAME, "Facilitator", "FACILITATOR", "my board", "iPhone notes"]);
});

test("an icon added from the gate is offered as Facilitator", async () => {
  const gate = await request(port + 1, "/m");
  assert.equal(gate.status, 200);
  assert.match(gate.text, /aria-label="Sign in to Facilitator"/, "the signed-out open was not the gate");
  assert.equal(titleTagOf(gate.text), APP_NAME);
  const manifest = JSON.parse((await request(port + 1, "/m-manifest.json")).text);
  const pageTitle = headTag(gate.text, /<title>([^<]*)<\/title>/);
  assert.equal(suggestedName(titleTagOf(gate.text), manifest, pageTitle), APP_NAME);
  // with the tag gone the manifest still gives the same name
  assert.equal(suggestedName(null, manifest, pageTitle), APP_NAME);
});

// the board page's naming rule, taken from the served page and run against a
// stand-in tag after a reading of the board
function nameAfterReading(page, initial, title) {
  const fnStart = page.indexOf("function appNameFor(title){");
  assert.ok(fnStart > 0, "the board page has no appNameFor");
  const fn = page.slice(fnStart, page.indexOf("\n}\n", fnStart) + 2);
  const ruleStart = page.indexOf("  const appName = document.querySelector('meta[name=\"apple-mobile-web-app-title\"]');");
  assert.ok(ruleStart > 0, "the board page no longer rewrites its home screen tag");
  const ruleEnd = page.indexOf("\n", page.indexOf("appName.content =", ruleStart));
  const rule = page.slice(ruleStart, ruleEnd);
  const tag = { content: initial };
  const context = vm.createContext({
    state: { title },
    document: { querySelector: selector =>
      (selector === 'meta[name="apple-mobile-web-app-title"]' ? tag : null) },
  });
  vm.runInContext(fn + "\n{\n" + rule + "\n}", context, { filename: "m.html naming rule" });
  return tag.content;
}

test("an icon added from the board page is offered as Facilitator, before and after the first reading", async () => {
  const cookie = await signIn();
  const served = await request(port + 1, "/m", { Cookie: cookie });
  assert.equal(served.status, 200);
  assert.match(served.text, /<aside id="settings"/, "the signed-in open did not get the board page");
  const initial = titleTagOf(served.text);
  assert.equal(initial, APP_NAME, "the page's own tag is not the app's name");
  const state = JSON.parse((await request(port + 1, "/m/state", { Cookie: cookie })).text);
  const named = nameAfterReading(served.text, initial, state.title);
  assert.equal(named, APP_NAME, "a reading of the board put the lowercase name back");
  const manifest = JSON.parse((await request(port + 1, "/m-manifest.json", { Cookie: cookie })).text);
  assert.equal(suggestedName(named, manifest, state.title), APP_NAME);
  // a title the owner chose still reaches the tag exactly as written
  assert.equal(nameAfterReading(served.text, initial, "my board"), "my board");
  assert.equal(nameAfterReading(served.text, initial, "Tab bar test"), "Tab bar test");
});

test("the files on disk carry no lowercase app name", async () => {
  for (const name of ["m-gate.html", "m.html"]) {
    assert.equal(titleTagOf(await readFile(path.join(ROOT, name), "utf8")), APP_NAME, name);
  }
  const manifest = JSON.parse(await readFile(path.join(ROOT, "m-manifest.json"), "utf8"));
  assert.equal(manifest.name, APP_NAME);
  assert.equal(manifest.short_name, APP_NAME);
});
