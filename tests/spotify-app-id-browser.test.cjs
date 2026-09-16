// The Spotify connect stub in magic box 1, in its two states. With an app id
// configured the stub reads "Connect Spotify" and its sign-in carries that id;
// with none it reads "Create Spotify App ID" and opens Spotify's dashboard. The
// two stubs are the same shape and only the words and the press target differ.
//
// This launches its own headless Chrome and never touches the shared debugging
// port or the live board. The fixture board runs on a free port, never 8877.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createServer } = require("node:http");
const { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const puppeteer = require("puppeteer-core");

const ROOT = path.resolve(__dirname, "..");
const PYTHON = process.env.FACILITATOR_TEST_PYTHON || path.join(ROOT, ".venv", "bin", "python3");
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SHOTS = process.env.SPOTIFY_SHOTS || "";
const BOARD = { width: 1440, height: 900, deviceScaleFactor: 2 };
const INVENTED = "invented-spotify-app-id-31415926";
const DASHBOARD = "https://developer.spotify.com/dashboard";
const COPIED = ["index.html", "page.html", "m.html", "m-sw.js", "m-manifest.json", "cm-markdown.js",
                "compose-format.js", "card-markdown.js", "card-logic.js", "card-report.js", "card-tokens.css"];

let baseDir, serverSource, browser, seq = 0;
const running = [];
const sigs = {};

async function freePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

async function startServer(config) {
  const dir = path.join(baseDir, "srv-" + (++seq));
  await mkdir(dir, { recursive: true });
  const port = await freePort();
  await writeFile(path.join(dir, "server.py"), serverSource);
  for (const name of COPIED) await copyFile(path.join(ROOT, name), path.join(dir, name));
  await mkdir(path.join(dir, "assets"));
  for (const name of await readdir(path.join(ROOT, "assets")))
    await copyFile(path.join(ROOT, "assets", name), path.join(dir, "assets", name));
  await writeFile(path.join(dir, "run.config.json"), JSON.stringify(config));
  await writeFile(path.join(dir, "seed.json"), JSON.stringify({
    title: "spotify id fixture",
    items: [{ id: "0", bucket: "meta", title: "Standing card", owner: "facilitator" }],
  }));

  const origin = "http://127.0.0.1:" + port;
  const child = spawn(PYTHON, [path.join(dir, "server.py")], {
    cwd: dir,
    env: { ...process.env, FACILITATOR_TEST_PORT: String(port), FACILITATOR_LOG_DIR: dir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  running.push(child);
  let output = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("server exited early:\n" + output);
    try { if ((await fetch(origin + "/state")).ok) return origin; } catch (error) {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  child.kill("SIGKILL");
  throw new Error("server did not start:\n" + output);
}

// A page on the fixture board with the browser held off the network: only the
// board's own origin answers, and window.open is caught rather than followed so
// a press records where it would have gone instead of opening a real tab.
async function openBoard(origin) {
  const page = await browser.newPage();
  page.errors = [];
  page.on("pageerror", error => page.errors.push(error.message));
  await page.setViewport(BOARD);
  await page.evaluateOnNewDocument(() => {
    try { localStorage.clear(); } catch (error) {}
    window.__opened = [];
    window.open = (url, target, features) => {
      window.__opened.push({
        url: String(url),
        target: target == null ? "" : String(target),
        features: features == null ? "" : String(features),
      });
      return null;
    };
  });
  await page.setRequestInterception(true);
  page.on("request", req => {
    const url = req.url();
    if (url.startsWith(origin + "/") || /^(data|blob):/.test(url)) req.continue();
    else req.abort();
  });
  await page.goto(origin + "/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof lastState !== "undefined" && lastState !== null,
    { timeout: 15000 });
  return page;
}

async function waitStub(page, label) {
  await page.waitForFunction(want => {
    const span = document.querySelector("#magic1 .spconnect span");
    return !!span && span.textContent === want;
  }, { timeout: 15000 }, label);
}

async function pressStub(page) {
  await page.evaluate(() => document.querySelector("#magic1 .spconnect").click());
  await page.waitForFunction(() => window.__opened.length > 0, { timeout: 10000 });
  return page.evaluate(() => window.__opened[0]);
}

// everything about the stub but the words and where it points: enough to show
// the two states are the same shape, font, size, alignment and colour
async function signature(page) {
  return page.evaluate(() => {
    const b = document.querySelector("#magic1 .spconnect");
    const cs = getComputedStyle(b);
    return {
      cls: b.className,
      hasMark: !!b.querySelector("svg"),
      fontFamily: cs.fontFamily, fontSize: cs.fontSize, fontWeight: cs.fontWeight,
      lineHeight: cs.lineHeight, color: cs.color,
      borderWidth: cs.borderTopWidth, borderStyle: cs.borderTopStyle, borderColor: cs.borderTopColor,
      borderRadius: cs.borderTopLeftRadius,
      padding: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].join(" "),
      display: cs.display, alignItems: cs.alignItems, gap: cs.columnGap,
    };
  });
}

async function shoot(page, name) {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  const box = await page.evaluate(() => {
    const r = document.getElementById("magic1").getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  await page.screenshot({
    path: path.join(SHOTS, name + ".png"),
    clip: { x: Math.max(0, Math.floor(box.x)), y: Math.max(0, Math.floor(box.y)),
            width: Math.ceil(box.width), height: Math.ceil(box.height) },
  });
}

before(async () => {
  baseDir = await mkdtemp(path.join(tmpdir(), "facilitator-spotify-stub-"));
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  serverSource = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(serverSource, source, "fixture server port was not patched");
  browser = await puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: ["--no-first-run", "--disable-background-networking"],
  });
});

after(async () => {
  if (browser) await browser.close();
  for (const child of running) {
    if (child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
  }
  if (baseDir) await rm(baseDir, { recursive: true, force: true });
});

test("no configured id shows the create stub that opens the dashboard", async () => {
  const origin = await startServer({});
  const page = await openBoard(origin);
  try {
    await waitStub(page, "Create Spotify App ID");
    sigs.create = await signature(page);
    await shoot(page, "create-state");
    const opened = await pressStub(page);
    assert.equal(opened.url, DASHBOARD, "the create stub pressed to the wrong place");
    assert.equal(opened.target, "_blank", "the dashboard did not open in a new tab");
    assert.deepEqual(page.errors, [], "the page raised an error");
  } finally {
    await page.close();
  }
});

test("a configured id shows the connect stub whose sign-in carries the id", async () => {
  const origin = await startServer({ spotify_client_id: INVENTED });
  const page = await openBoard(origin);
  try {
    await waitStub(page, "Connect Spotify");
    sigs.connect = await signature(page);
    await shoot(page, "connect-state");
    const opened = await pressStub(page);
    const url = new URL(opened.url);
    assert.equal(url.origin, "https://accounts.spotify.com", "sign-in did not go to Spotify");
    assert.equal(url.pathname, "/authorize", "sign-in did not open the authorize page");
    assert.equal(url.searchParams.get("client_id"), INVENTED,
      "the sign-in did not carry the configured id");
    assert.deepEqual(page.errors, [], "the page raised an error");
  } finally {
    await page.close();
  }
});

test("the two stubs are the same shape apart from the words", async () => {
  assert.ok(sigs.create && sigs.connect, "both stub states must be rendered first");
  assert.deepEqual(sigs.create, sigs.connect,
    "the create stub and the connect stub differ beyond their words");
});
