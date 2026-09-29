// What a freshly added home screen icon opens on, proved without a browser.
//
// iOS copies two things into an icon when it is added, from whichever page it
// is added from, and never asks again: the launch picture and the status bar
// setting. That page is the sign-in page (the gate) the bridge shows at /m to
// anyone signed out, so the gate has to carry both: the full screen status bar
// meta, and the squid painter, which is one shared file both pages load. Then
// the board page itself, whose first frame is the white globe curtain: it must
// need no second file before that frame (the shared card sheet is folded into
// the page as it is served, and the web font sheets are asked for off the
// first paint), and the curtain must not lift until the web faces have landed,
// on a readiness signal rather than a clock.
//
// The server here is a real copy in a temp directory behind a fake Tailscale
// CLI, on ports the OS picks, and every request is plain HTTP. The painter,
// the font sheets' script and the curtain's rule run in node:vm against
// stand-ins. Nothing here opens a browser or touches port 8877, and the board
// is invented.
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
const PASS = "LaunchFixture7!";
const COPIED = ["m.html", "m-sw.js", "m-manifest.json", "card-markdown.js", "card-tokens.css",
                "card-logic.js", "card-report.js", "compose-format.js", "index.html", "page.html",
                "manifest.json", "sw.js"];
// board content the signed-out pages must never carry
const BOARD_SECRETS = ["m874 launch fixture board", "An invented private card title",
                       "Invented private context that no signed-out page may show"];
const SHEET_LINK = '<link rel="stylesheet" href="/card-tokens.css">';
// the two web font sheets the page asked for in its head before this change,
// word for word: moving them must not change which faces the page is set in.
// Plex Sans is also asked for at 700 now, for the drawer's selected tab name
const WEB_FONT_SHEETS = [
  "https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;0,6..72,600;1,6..72,400&family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap",
  "https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap",
];
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 " +
               "(KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";
const IPAD = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
             "(KHTML, like Gecko) Version/18.6 Safari/605.1.15";
const DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
                "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const ANDROID = "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) " +
                "Chrome/140.0.0.0 Mobile Safari/537.36";

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
      res.on("end", () => {
        const all = Buffer.concat(parts);
        resolve({ status: res.statusCode, headers: res.headers, bytes: all, text: all.toString("utf8") });
      });
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

before(async () => {
  outer = await mkdtemp(path.join(tmpdir(), "facilitator-m874-launch-"));
  app = path.join(outer, "app");
  const bin = path.join(outer, "bin");
  await mkdir(app);
  await mkdir(bin);
  // a Tailscale CLI with no Serve rules at all, first on the PATH, so the board
  // never asks the machine's own
  await writeFile(path.join(bin, "tailscale"), "#!/bin/sh\necho '{}'\n");
  await chmod(path.join(bin, "tailscale"), 0o755);
  let source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])")
    .replace('TAILSCALE_APP = "/Applications/Tailscale.app/Contents/MacOS/Tailscale"',
             'TAILSCALE_APP = "/facilitator-test/no-tailscale-app"');
  assert.match(patched, /PORT = int\(os\.environ\['FACILITATOR_TEST_PORT'\]\)/, "the port was not patched");
  assert.match(patched, /TAILSCALE_APP = "\/facilitator-test\/no-tailscale-app"/,
    "the fixture could fall through to the real Tailscale app");
  source = patched;
  await writeFile(path.join(app, "server.py"), source);
  require("./fixture-auth.cjs").copyBridgeFiles(app);
  for (const name of COPIED) await copyFile(path.join(ROOT, name), path.join(app, name));
  await cp(path.join(ROOT, "assets"), path.join(app, "assets"), { recursive: true });
  await writeFile(path.join(app, "seed.json"), JSON.stringify({
    title: BOARD_SECRETS[0],
    items: [{ id: "0", bucket: "now", title: BOARD_SECRETS[1], owner: "facilitator",
              context: BOARD_SECRETS[2] }],
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

// every inline script in a page, as source
function inlineScripts(html) {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
}

// ---- the gate: the page every new icon is added from ---------------------------------

test("a signed-out open of /m is only the gate, full screen, with the painter loaded and called before the steps", async () => {
  const gate = await request(port + 1, "/m");
  assert.equal(gate.status, 200);
  assert.match(gate.headers["content-type"], /^text\/html/);
  const head = gate.text.slice(0, gate.text.indexOf("</head>"));
  assert.match(head, /<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">/,
    "the gate does not ask for a full screen app, so every icon added from it opens below the clock");
  assert.match(head, /<meta name="apple-mobile-web-app-capable" content="yes">/);
  assert.match(head, /<meta name="viewport" content="[^"]*viewport-fit=cover[^"]*">/,
    "without viewport-fit=cover the safe area insets read as nothing");
  // the gate and nothing of the board
  assert.match(gate.text, /aria-label="Install Facilitator"/);
  assert.match(gate.text, /aria-label="Sign in to Facilitator"/);
  assert.equal(gate.text.includes('id="loading"'), false, "the board page was served signed out");
  assert.equal(gate.text.includes('<aside id="settings"'), false, "the board page was served signed out");
  for (const secret of BOARD_SECRETS) assert.equal(gate.text.includes(secret), false, "the gate showed " + secret);
  // the painter is loaded ahead of the gate's own script and called at its very
  // top, before the staged reveal of the install steps and the sign-in switch
  const include = gate.text.indexOf('<script src="/m-splash.js"></script>');
  assert.ok(include > 0, "the gate does not load the painter");
  const own = gate.text.indexOf("<script>", include);
  assert.equal(gate.text.slice(include, own), '<script src="/m-splash.js"></script>\n',
    "the painter is not the file loaded just before the gate's own script");
  const script = gate.text.slice(own, gate.text.indexOf("</script>", own));
  const call = script.indexOf('if (typeof installStartupImage === "function") installStartupImage(SPLASH_LOGO);');
  assert.ok(call > 0, "the gate never calls the painter");
  assert.ok(call < script.indexOf("if (installed) showLogin();"), "the painter is called after the sign-in switch");
  assert.ok(call < script.indexOf("const run = () =>"), "the painter is called after the steps are set going");
  // the gate's scripts still parse
  for (const code of inlineScripts(gate.text)) new vm.Script(code, { filename: "m-gate.html" });
  // signed-out / is the same gate
  const root = await request(port + 1, "/");
  assert.equal(root.text, gate.text);
});

test("the gate's content rule allows the painter and everything it draws with", async () => {
  const gate = await request(port + 1, "/m");
  const rule = Object.fromEntries(gate.headers["content-security-policy"].split(";")
    .map(part => part.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));
  assert.ok(rule["script-src"].includes("'self'"), "the painter's own file would be refused");
  assert.ok(rule["img-src"].includes("'self'"), "the squid would be refused");
  assert.ok(rule["img-src"].includes("data:"), "the painted picture, a data: address, would be refused");
  assert.equal("font-src" in rule, false);
  assert.deepEqual(rule["default-src"], ["'self'"], "the gate's content rule was loosened");
  // the gate loads no web face, so the painter's system faces are all it needs
  assert.equal(/fonts\.g(oogleapis|static)\.com/.test(gate.text), false);
});

test("the gate keeps both cards clear of the clock and the home bar on all four sides", async () => {
  const gate = (await request(port + 1, "/m")).text;
  const rule = selector => {
    const at = gate.indexOf("\n  " + selector + "{");
    assert.ok(at > 0, "no " + selector + " rule");
    return gate.slice(at, gate.indexOf("}", at));
  };
  for (const selector of ["body", "body.login"]) {
    const padding = /padding:([^;]+);/.exec(rule(selector))[1];
    for (const side of ["top", "right", "bottom", "left"]) {
      assert.match(padding, new RegExp(`env\\(safe-area-inset-${side}, 0px\\)`),
        `${selector} does not add the ${side} safe area to its margin`);
    }
  }
});

test("the painter is a public file, the one on disk, and it holds and asks for nothing of the board", async () => {
  const painter = await request(port + 1, "/m-splash.js");
  assert.equal(painter.status, 200, "the painter is not reachable signed out");
  assert.match(painter.headers["content-type"], /^application\/javascript/);
  assert.deepEqual(painter.bytes, await readFile(path.join(ROOT, "m-splash.js")));
  for (const secret of BOARD_SECRETS) assert.equal(painter.text.includes(secret), false);
  assert.doesNotMatch(painter.text,
    /\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|localStorage|sessionStorage|indexedDB|document\.cookie|\/state\b|\/auth\//,
    "the painter reaches for board data or a session");
  // the one address it names is the squid, which is public too
  assert.deepEqual(painter.text.match(/"\/[^"]*"/g), ['"/m-splash-squid.png"']);
  const squid = await request(port + 1, "/m-splash-squid.png");
  assert.equal(squid.status, 200);
  assert.equal(squid.headers["content-type"], "image/png");
  // and signed out, the board is still behind the gate
  for (const route of ["/m/state", "/state", "/card-tokens.css"]) {
    assert.equal((await request(port + 1, route)).status, 401, route + " answered signed out");
  }
});

// ---- the painter itself, run as each page runs it ------------------------------------

// the painter in a context of its own, with a recording canvas and a squid the
// test hands over. no fetch: a painter that asked the network would throw
async function painterIn({ ua, standalone = false, touch = 0, screen = { width: 375, height: 812 }, dpr = 3 }) {
  const source = await readFile(path.join(ROOT, "m-splash.js"), "utf8");
  const appended = [], images = [], canvases = [], calls = [];
  const ctx = {
    fillStyle: "", textAlign: "", textBaseline: "", _font: "10px sans-serif",
    set font(value) { this._font = value; calls.push(["font", value]); },
    get font() { return this._font; },
    fillRect: (...a) => calls.push(["fillRect", ctx.fillStyle, ...a]),
    drawImage: (img, ...a) => calls.push(["drawImage", img.src, ...a]),
    fillText: (...a) => calls.push(["fillText", ctx.fillStyle, ctx.textAlign, ctx.textBaseline, ...a]),
    save: () => calls.push(["save"]), restore: () => calls.push(["restore"]),
    scale: (...a) => calls.push(["scale", ...a]),
  };
  const context = vm.createContext({
    screen, devicePixelRatio: dpr,
    navigator: { userAgent: ua, maxTouchPoints: touch, standalone },
    matchMedia: query => ({ matches: standalone && query === "(display-mode: standalone)" }),
    Image: class { constructor() { images.push(this); } },
    document: {
      head: { appendChild: el => appended.push(el) },
      createElement: tag => {
        if (tag !== "canvas") return { tagName: tag };
        const canvas = { width: 0, height: 0, getContext: () => ctx,
                         toDataURL: type => "data:" + type + ";base64,UEFJTlRFRA==" };
        canvases.push(canvas);
        return canvas;
      },
    },
    fetch: () => { throw new Error("the painter asked the network for something"); },
  });
  context.window = context;
  vm.runInContext(source, context, { filename: "m-splash.js" });
  return { appended, images, canvases, calls, run: code => vm.runInContext(code, context) };
}

test("on the gate the painter paints this phone's picture from the squid alone", async () => {
  // Safari on the owner's phone, before installing, with no session of any kind
  const phone = await painterIn({ ua: IPHONE });
  phone.run("installStartupImage(SPLASH_LOGO)");
  assert.equal(phone.images.length, 1);
  assert.equal(phone.images[0].src, "/m-splash-squid.png");
  // the squid lands, taller than wide as the real one is
  Object.assign(phone.images[0], { naturalWidth: 60, naturalHeight: 90 });
  phone.images[0].onload();
  assert.equal(phone.appended.length, 1, "no launch picture was put in the page's head");
  const link = phone.appended[0];
  assert.equal(link.rel, "apple-touch-startup-image");
  assert.equal(link.media, "(device-width: 375px) and (device-height: 812px) " +
    "and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)");
  assert.match(link.href, /^data:image\/png;base64,/);
  assert.deepEqual([phone.canvases[0].width, phone.canvases[0].height], [1125, 2436]);
  // white, then the squid, then the credit line in grey
  assert.deepEqual(phone.calls[0], ["fillRect", "#ffffff", 0, 0, 1125, 2436]);
  assert.equal(phone.calls[1][0], "drawImage");
  assert.equal(phone.calls[1][1], "/m-splash-squid.png");
  const text = phone.calls.find(call => call[0] === "fillText");
  assert.deepEqual(text.slice(1, 5), ["#aeaeb2", "center", "middle", "@theonetrueakash"]);
  // the credit line is set in the phone's own faces: nothing for the gate to
  // load, and it looks the same whichever page painted it
  const faces = phone.calls.filter(call => call[0] === "font").map(call => call[1]);
  assert.ok(faces.length >= 1);
  assert.match(faces[0], /^\d+(\.\d+)?px -apple-system, BlinkMacSystemFont, "SF Pro Text"/);
  for (const face of faces) assert.doesNotMatch(face, /Plex|Inter|Newsreader/);
  // once per load
  phone.run("installStartupImage(SPLASH_LOGO)");
  assert.equal(phone.images.length, 1, "the painter ran twice");
});

test("the painter runs only where iOS reads the tag, as it did in the board page", async () => {
  for (const [what, options, paints] of [
    ["an iPhone tab", { ua: IPHONE }, true],
    ["an iPad, which reports a Mac with a touch screen", { ua: IPAD, touch: 5 }, true],
    ["a Mac without touch", { ua: IPAD }, false],
    ["a desktop browser", { ua: DESKTOP }, false],
    ["an Android tab", { ua: ANDROID }, false],
    ["any installed window", { ua: ANDROID, standalone: true }, true],
  ]) {
    const page = await painterIn(options);
    page.run("installStartupImage(SPLASH_LOGO)");
    assert.equal(page.images.length, paints ? 1 : 0, what);
  }
  // a squid that never arrives costs the picture and throws nothing
  const phone = await painterIn({ ua: IPHONE });
  phone.run("installStartupImage(SPLASH_LOGO)");
  assert.equal(phone.appended.length, 0);
});

test("the board page loads the same painter, keeps no copy of its own and still calls it after the first reading", async () => {
  const page = await readFile(path.join(ROOT, "m.html"), "utf8");
  const include = page.indexOf('<script src="/m-splash.js"></script>');
  assert.ok(include > 0, "the board page does not load the painter");
  const main = page.indexOf('<script>\ndocument.getElementById("signout")');
  assert.ok(main > include, "the painter is loaded after the page's own script");
  for (const name of ["splashLayout", "splashHandleBox", "applySplashFont", "drawSplashHandle",
                      "paintSplash", "isAppleHomeScreenTarget", "installStartupImage"]) {
    assert.equal(new RegExp(`function ${name}\\(`).test(page), false, `the board page keeps its own ${name}`);
  }
  assert.doesNotMatch(page, /const SPLASH_/);
  const boot = page.indexOf("loadOps();\ndrawCreatePending();\npoll();\n");
  const call = page.indexOf('if (typeof installStartupImage === "function") installStartupImage(SPLASH_LOGO);');
  assert.ok(boot > 0 && call > boot, "the picture is no longer painted after the first reading is asked for");
  // the numbers the startup suite pins for the board page, from the shared file
  const painter = await painterIn({ ua: IPHONE });
  const g = painter.run("splashLayout({ screenW: 390, screenH: 844, dpr: 3, logoAspect: 60 / 90 })");
  assert.deepEqual([g.canvasW, g.canvasH], [1170, 2532]);
  assert.equal(g.logoH, 1170 * 0.32);
  assert.ok(Math.abs(g.logoW - 1170 * 0.32 * (60 / 90)) < 1e-9);
  assert.equal(g.logoX + g.logoW / 2, 1170 / 2);
  assert.equal(g.logoY + g.logoH / 2, 2532 / 2);
  assert.equal(g.handleFont, Math.round(1170 * 0.035));
  assert.equal(g.handleCenterX, 1170 / 2);
  assert.equal(g.handleCenterY, 2532 - 1170 * 0.12);
  assert.equal(g.media, "(device-width: 390px) and (device-height: 844px) " +
    "and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)");
});

// ---- the board page's first frame -----------------------------------------------------

test("signed in, /m carries the shared card sheet's own text in place of its link", async () => {
  const cookie = await signIn();
  const served = await request(port + 1, "/m", { Cookie: cookie });
  assert.equal(served.status, 200);
  assert.match(served.text, /<aside id="settings"/, "the signed-in open did not get the board page");
  const file = await readFile(path.join(ROOT, "m.html"), "utf8");
  const sheet = await readFile(path.join(ROOT, "card-tokens.css"), "utf8");
  assert.ok(file.includes(SHEET_LINK), "the file itself lost its link");
  assert.equal(served.text.includes(SHEET_LINK), false, "the served page still links the sheet");
  assert.equal(/href="\/card-tokens\.css"/.test(served.text), false, "the served page still asks for the sheet");
  const inline = `<style data-sheet="/card-tokens.css">\n${sheet}</style>`;
  assert.equal(served.text, file.replace(SHEET_LINK, () => inline),
    "the served page differs from the file by more than the one link");
  const at = served.text.indexOf(inline);
  assert.ok(at > 0 && at < served.text.indexOf("</head>"), "the sheet is not in the head");
  assert.ok(at < served.text.indexOf('<div id="loading"'), "the sheet comes after the curtain");
  // the unguarded local port serves the same page
  assert.equal((await request(port, "/m")).text, served.text);
  // and every other reader of the sheet is as it was
  const css = await request(port, "/card-tokens.css");
  assert.equal(css.status, 200);
  assert.match(css.headers["content-type"], /^text\/css/);
  assert.equal(css.text, sheet);
  assert.equal((await request(port + 1, "/card-tokens.css", { Cookie: cookie })).text, sheet);
  assert.ok((await request(port, "/")).text.includes(SHEET_LINK), "the desktop page stopped linking the sheet");
  const worker = await readFile(path.join(ROOT, "m-sw.js"), "utf8");
  assert.match(worker, /const SHELL = \[[^\]]*"\/card-tokens\.css"/, "the phone's worker stopped keeping the sheet");
  // a page open is asked of the server every time; the worker keeps no copy of
  // it and only stands the server-down screen in when the server cannot answer
  assert.match(worker, /if \(request\.mode === "navigate"\) \{\s*if \(url\.pathname === "\/m"\) event\.respondWith\(openPage\(request\)\);\s*return;\s*\}/,
    "the worker does something other than ask the server for a page open");
  const openPage = worker.slice(worker.indexOf("async function openPage"), worker.indexOf("function bounded"));
  assert.ok(openPage.includes("await fetch(request)") && !/caches/.test(openPage),
    "the worker answers a page open from a kept copy");
  // the served page's scripts still parse
  for (const code of inlineScripts(served.text)) new vm.Script(code, { filename: "m.html" });
});

test("the served board page waits on no stylesheet, and no script runs before the curtain", async () => {
  const served = (await request(port + 1, "/m", { Cookie: await signIn() })).text;
  const head = served.slice(0, served.indexOf("</head>"));
  const links = head.match(/<link\b[^>]*>/g) || [];
  assert.deepEqual(links.filter(tag => /rel="stylesheet"/.test(tag)), [], "a stylesheet link is left in the head");
  // the only tags that name another site are the two preconnects, which only
  // warm the connection and hold nothing back
  const outside = served.match(/<link\b[^>]*fonts\.g(?:oogleapis|static)\.com[^>]*>/g) || [];
  assert.deepEqual(outside.map(tag => /rel="preconnect"/.test(tag)), [true, true]);
  assert.ok(served.indexOf('<div id="loading"') < served.indexOf("<script"), "a script runs before the curtain");
});

// the font sheets' script, run with a document that records what it is asked to add
function fontScriptIn(page) {
  const start = page.indexOf("<script>\n  // the web font sheets");
  assert.ok(start > 0, "no script asks for the web font sheets");
  const code = page.slice(start + "<script>".length, page.indexOf("</script>", start));
  const added = [];
  const context = vm.createContext({
    Promise,
    document: {
      head: { appendChild: el => added.push(el) },
      createElement: tagName => ({
        tagName, rel: "", media: "", href: "", listeners: {},
        addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
        fire(type) { for (const fn of this.listeners[type] || []) fn(); },
      }),
    },
  });
  context.window = context;
  vm.runInContext(code, context, { filename: "m.html font sheets" });
  return { added, settled: context.webFontSheets, start };
}

test("the web font sheets are the same two, asked for under a media query no screen waits on", async () => {
  const page = await readFile(path.join(ROOT, "m.html"), "utf8");
  const { added, settled, start } = fontScriptIn(page);
  assert.ok(start > page.indexOf('<div id="page">'), "the font sheets are asked for ahead of the page's markup");
  assert.deepEqual(added.map(el => [el.tagName, el.rel, el.media, el.href]),
    WEB_FONT_SHEETS.map(href => ["link", "stylesheet", "print", href]));
  let done = false;
  settled.then(() => { done = true; });
  const flush = async () => { for (let i = 0; i < 10; i++) await null; };
  added[0].fire("load");
  await flush();
  assert.equal(added[0].media, "all", "a sheet that landed was not switched on");
  assert.equal(done, false, "the sheets answered while one was still on its way");
  // a refusal is an answer too, and leaves that sheet off
  added[1].fire("error");
  await flush();
  assert.equal(added[1].media, "print");
  assert.equal(done, true, "a refused sheet held the answer back");
});

// ---- the curtain waits for the faces ----------------------------------------------------

// the curtain's rule from the page, run against a curtain, a screen and a font
// set the test controls. frames run only when the test says so, and the only
// timers are recorded rather than run
async function curtainIn() {
  const page = await readFile(path.join(ROOT, "m.html"), "utf8");
  const start = page.indexOf("// --- the curtain's rule ---");
  const end = page.indexOf("// ---- the poll");
  assert.ok(start > 0 && end > start, "the curtain's rule has moved");
  const section = page.slice(start, end);
  const code = section + `
globalThis.__startup = { startupRendered,
  get lifted(){ return startupLifted; }, get still(){ return startupStill; } };`;
  const frames = [], timers = [];
  const curtain = { style: {}, classList: { add() {}, remove() {} }, removed: false,
                    remove() { this.removed = true; } };
  const control = {};
  const fonts = { ready: new Promise(resolve => { control.faces = resolve; }) };
  const context = vm.createContext({
    Promise, Math, Array, WeakSet,
    navigator: { standalone: true },
    matchMedia: () => ({ matches: true }),
    document: { getElementById: id => (id === "loading" ? curtain : null), querySelector: () => null, fonts },
    requestAnimationFrame: fn => { frames.push(fn); return frames.length; },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    innerHeight: 812,
  });
  context.window = context;
  context.webFontSheets = new Promise(resolve => { control.sheets = resolve; });
  vm.runInContext(code, context, { filename: "m.html curtain" });
  const flush = async () => { for (let i = 0; i < 20; i++) await null; };
  const frame = async (count) => {
    for (let i = 0; i < count; i++) { await flush(); for (const fn of frames.splice(0)) fn(); }
    await flush();
  };
  return { section, curtain, timers, frame, control, startup: context.__startup };
}

test("the curtain holds until the font sheets have answered and document.fonts.ready has, then lifts", async () => {
  const t = await curtainIn();
  // the minimum hold has passed and a board has been drawn
  t.timers.find(timer => timer.ms === 1000).fn();
  void t.startup.startupRendered();
  await t.frame(12);
  assert.equal(t.curtain.style.opacity, undefined, "the curtain lifted while the font sheets were still on their way");
  assert.equal(t.startup.still, false);
  t.control.sheets();
  await t.frame(12);
  assert.equal(t.curtain.style.opacity, undefined, "the curtain lifted before document.fonts.ready answered");
  assert.equal(t.startup.still, false, "the page called itself still before its faces had landed");
  t.control.faces();
  await t.frame(12);
  assert.equal(t.startup.still, true);
  assert.equal(t.curtain.style.opacity, "0", "the curtain never lifted once the faces had landed");
  assert.equal(t.startup.lifted, true);
  // no clock was added: the only timers are the minimum hold and the fade
  assert.deepEqual(t.timers.map(timer => timer.ms), [1000, 260]);
});

test("the faces are waited for by readiness alone, and the typing row is fitted again on the same signal", async () => {
  const t = await curtainIn();
  assert.equal((t.section.match(/setTimeout\(/g) || []).length, 2, "the curtain's rule gained a timer");
  const helper = t.section.slice(t.section.indexOf("function webFacesLanded(){"),
                                 t.section.indexOf("\n}\n", t.section.indexOf("function webFacesLanded(){")));
  assert.match(helper, /await window\.webFontSheets/);
  assert.match(helper, /await document\.fonts\.ready/);
  assert.doesNotMatch(helper, /setTimeout|setInterval|Date\.now|performance\.now/);
  const rendered = t.section.slice(t.section.indexOf("async function startupRendered(){"));
  assert.ok(rendered.indexOf("await webFacesLanded();") > 0 &&
            rendered.indexOf("await webFacesLanded();") < rendered.indexOf("startupStill = true;"),
    "the stillness that lifts the curtain is not waited for after the faces");
  const page = await readFile(path.join(ROOT, "m.html"), "utf8");
  assert.match(page, /webFacesLanded\(\)\.then\(\(\) => tick\(\)\);/, "the typing row is not fitted again once the faces land");
  assert.equal(/document\.fonts\.ready\.then/.test(page), false,
    "something still asks document.fonts.ready without waiting for the sheets first");
});
