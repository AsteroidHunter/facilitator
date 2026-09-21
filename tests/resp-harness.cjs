// Shared fixture launcher for the responsive-workspace checks. It stands up a
// throwaway product server against an ephemeral loopback port pair, a fake HOME,
// and a fake tailscale command, then a private headless Chrome. Nothing here
// touches the live board on 8877 or the real Tailscale app.
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } =
  require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const puppeteer = require("puppeteer-core");
const { copyBridgeFiles, freePortPair } = require("./fixture-auth.cjs");

const ROOT = path.resolve(__dirname, "..");
const CHROME = process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PYTHON = process.env.FACILITATOR_TEST_PYTHON || "python3";

const COPY_FILES = ["index.html", "page.html", "m.html", "m-sw.js", "m-manifest.json", "sw.js",
  "manifest.json", "card-markdown.js", "card-tokens.css", "card-logic.js", "card-report.js",
  "compose-format.js", "cm-markdown.js"];

// A stub that answers the two read-only Tailscale queries server.py makes at
// startup with empty JSON, so no legacy-serve rule is ever seen and the real
// binary is never run. Any other argument prints nothing and exits 0.
const FAKE_TAILSCALE = `#!/bin/sh
case "$*" in
  *"serve status"*) echo '{}' ;;
  *"status"*) echo '{"BackendState":"Stopped"}' ;;
  *) : ;;
esac
exit 0
`;

async function launch({ seed } = {}) {
  const fixtureDir = await realpath(await mkdtemp(path.join(tmpdir(), "facilitator-resp-")));
  const binDir = path.join(fixtureDir, "fakebin");
  await mkdir(binDir, { recursive: true });
  const fakeTs = path.join(binDir, "tailscale");
  await writeFile(fakeTs, FAKE_TAILSCALE);
  await chmod(fakeTs, 0o755);

  const port = await freePortPair();   // this port and port+1 are both free

  // Copy the product server, rebinding its port and disabling the absolute
  // Tailscale fallback so only the fake command on PATH could ever be used.
  let source = await readFile(path.join(ROOT, "server.py"), "utf8");
  source = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  source = source.replace(
    'TAILSCALE_APP = "/Applications/Tailscale.app/Contents/MacOS/Tailscale"',
    'TAILSCALE_APP = os.environ.get("FACILITATOR_FAKE_TAILSCALE_APP", "/nonexistent/tailscale")');
  if (!source.includes("FACILITATOR_TEST_PORT"))
    throw new Error("server.py port rebind failed; the PORT anchor moved");
  if (!source.includes("FACILITATOR_FAKE_TAILSCALE_APP"))
    throw new Error("server.py tailscale fallback neutralize failed; the anchor moved");
  await writeFile(path.join(fixtureDir, "server.py"), source);
  copyBridgeFiles(fixtureDir);

  for (const name of COPY_FILES)
    await copyFile(path.join(ROOT, name), path.join(fixtureDir, name));
  await mkdir(path.join(fixtureDir, "assets"));
  for (const name of await readdir(path.join(ROOT, "assets")))
    await copyFile(path.join(ROOT, "assets", name), path.join(fixtureDir, "assets", name));

  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify(seed || {
    title: "Responsive workspace fixture",
    items: [{ id: "0", bucket: "meta", owner: "facilitator", title: "Welcome card" }],
  }));

  const child = spawn(PYTHON, [path.join(fixtureDir, "server.py")], {
    cwd: fixtureDir,
    env: {
      ...process.env,
      HOME: fixtureDir,
      PATH: binDir + path.delimiter + (process.env.PATH || ""),
      FACILITATOR_TEST_PORT: String(port),
      FACILITATOR_LOG_DIR: fixtureDir,
      FACILITATOR_FAKE_TAILSCALE_APP: "/nonexistent/tailscale",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`fixture exited:\n${output}`);
    try { if ((await fetch(origin + "/state")).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  if (!(await fetch(origin + "/state")).ok) throw new Error(`fixture did not start:\n${output}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: ["--disable-background-networking", "--no-first-run", "--no-sandbox"],
  });

  async function post(route, body) {
    const response = await fetch(origin + route, { method: "POST", body });
    const result = await response.json();
    if (response.status !== 200)
      throw new Error(`${route}: ${response.status} ${JSON.stringify(result)}`);
    return result;
  }
  async function makeProject(name) {
    const dir = path.join(fixtureDir, "projects", name);
    await mkdir(dir, { recursive: true });
    return (await post("/project?name=" + encodeURIComponent(name), dir)).id;
  }
  async function openBoard(storage, viewport) {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setViewport(viewport || { width: 1440, height: 900 });
    if (storage) await page.evaluateOnNewDocument(entries => {
      for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
    }, storage);
    await page.goto(origin + "/", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.body.classList.contains("layout-ready") && typeof lastState !== "undefined" && lastState);
    await page.waitForFunction(() => getComputedStyle(document.getElementById("stage")).visibility === "visible");
    return { context, page };
  }
  async function stop() {
    if (browser) await browser.close();
    if (child && child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
    if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
  }

  return { origin, browser, fixtureDir, output: () => output, post, makeProject, openBoard, stop };
}

module.exports = { launch };
