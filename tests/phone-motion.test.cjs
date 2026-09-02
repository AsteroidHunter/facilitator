// The phone page's motion, driven headless at an iPhone size against its own
// fixture server: the card's two fades, the sent box's arrival, the send that
// lands at once and moves on, the two drawers opening the way the reference
// drawer does, the tab bar keeping its scroll, and the settings panel.
// Screenshots land under /tmp/m362-motion-shots.
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
const CHROME = process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SHOTS = "/tmp/m362-motion-shots";
const PHONE = { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const LONG_REPLY = Array.from({ length: 16 }, (_, i) =>
  `Paragraph ${i + 1}. The answer runs on for long enough to scroll under the title and to end against the sent box at the foot of the card.`).join("\n\n");

let browser;
let child;
let fixtureDir;
let origin;

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function api(route, body) {
  const response = await fetch(origin + route, { method: "POST", body });
  return { status: response.status, body: await response.json() };
}

async function create(title) {
  const result = await api("/create?owner=facilitator", title);
  assert.equal(result.status, 200);
  return result.body.id;
}

async function openPhone(route) {
  const page = await browser.newPage();
  const problems = [];
  page.on("console", message => {
    if (message.type() !== "error") return;
    if (/fonts\.g(oogleapis|static)\.com/.test(message.text())) return;   // the sandbox has no web fonts
    problems.push(message.text());
  });
  page.on("pageerror", error => problems.push("pageerror: " + error.message));
  await page.setViewport(PHONE);
  await page.goto(origin + route, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => lastState !== null, { timeout: 5000 });
  return { page, problems };
}

async function settle(ms = 250) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(SHOTS, name + ".png") });
}

before(async () => {
  await mkdir(SHOTS, { recursive: true });
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-phone-motion-"));
  const port = await freePort();
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "test server port was not patched");
  await writeFile(path.join(fixtureDir, "server.py"), patched);
  for (const name of ["m.html", "m-sw.js", "m-manifest.json", "card-markdown.js", "card-tokens.css", "card-logic.js", "index.html", "page.html"]) {
    await copyFile(path.join(ROOT, name), path.join(fixtureDir, name));
  }
  await mkdir(path.join(fixtureDir, "assets"));
  for (const name of await readdir(path.join(ROOT, "assets"))) {
    await copyFile(path.join(ROOT, "assets", name), path.join(fixtureDir, "assets", name));
  }
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({
    title: "phone motion test",
    items: [
      { id: "0", bucket: "meta", title: "Standing meta card", owner: "facilitator", context: "Drop meta thoughts here." },
      { id: "1.1", bucket: "now", title: "A pastureland card", owner: "pastureland", context: "Its own lane." },
    ],
  }));

  origin = `http://127.0.0.1:${port}`;
  child = spawn("python3", [path.join(fixtureDir, "server.py")], {
    cwd: fixtureDir,
    env: { ...process.env, FACILITATOR_TEST_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const deadline = Date.now() + 5000;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`fixture server exited:\n${output}`);
    try {
      const response = await fetch(origin + "/state");
      if (response.ok) { ready = true; break; }
    } catch {}
    await settle(25);
  }
  if (!ready) throw new Error(`fixture server did not start:\n${output}`);

  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--disable-background-networking", "--no-first-run"],
  });
});

after(async () => {
  if (browser) await browser.close();
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

test("the answer dissolves under the title as it scrolls and into the sent box at its foot", async () => {
  const id = await create("The card wears both fades");
  await api(`/reply?box=${id}`, LONG_REPLY);
  await api(`/send?box=${id}`, "A line sent and waiting");

  const { page, problems } = await openPhone(`/m?box=${id}`);
  try {
    await page.waitForSelector(`#box-${id}.sel .pendlist`, { timeout: 5000 });
    await settle(300);
    const rest = await page.evaluate(() => {
      const box = document.querySelector("article.box.sel");
      const reply = box.querySelector(".reply");
      const wrap = box.querySelector(".pendwrap");
      const cs = getComputedStyle(reply);
      return {
        wrapPosition: getComputedStyle(wrap).position,
        overlap: reply.getBoundingClientRect().bottom - wrap.getBoundingClientRect().top,
        band: cs.getPropertyValue("--boxband").trim(),
        wrapHeight: Math.round(wrap.getBoundingClientRect().height),
        up: cs.getPropertyValue("--upband").trim(),
        fade: cs.getPropertyValue("--replyfade").trim(),
        air: cs.getPropertyValue("--replyair").trim(),
        mask: cs.webkitMaskImage,
        composite: cs.webkitMaskComposite || cs.maskComposite,
        runout: cs.paddingBottom,
        scrolls: reply.scrollHeight > reply.clientHeight + 1,
      };
    });
    assert.equal(rest.wrapPosition, "absolute", "the sent box is not laid over the answer");
    assert.ok(rest.overlap > 40, `the answer does not run on under the box (${rest.overlap})`);
    assert.equal(rest.fade, "22px", "the ramp is not the desktop's depth");
    assert.equal(rest.air, "3.5px", "the clear air over the box is not the desktop's");
    assert.equal(rest.band, rest.wrapHeight + "px", "the ramp's top edge is not the box's top edge");
    assert.ok(rest.up === "" || rest.up === "0px", `an answer at rest carries a band under the title (${rest.up})`);
    assert.match(rest.mask, /linear-gradient/, "the answer carries no mask");
    assert.equal(rest.mask.match(/linear-gradient/g).length, 3, "the mask is not the desktop's three layers");
    assert.match(rest.composite, /intersect/);
    assert.equal(rest.runout, (parseFloat(rest.band) + 22).toFixed(0) + "px", "the scroll's run-out is not the band plus the ramp");
    assert.equal(rest.scrolls, true, "the answer under test does not scroll");
    await shot(page, "fade-rest");

    // one pixel of scroll buys one pixel of ramp, and the ramp stops at its depth
    const scrolled = await page.evaluate(async () => {
      const reply = document.querySelector("article.box.sel .reply");
      const read = () => getComputedStyle(reply).getPropertyValue("--upband").trim();
      const step = async to => {
        reply.scrollTop = to;
        await new Promise(r => setTimeout(r, 60));
        return read();
      };
      return { small: await step(7), deep: await step(400) };
    });
    assert.equal(scrolled.small, "7px", "the band under the title does not follow the scroll");
    assert.equal(scrolled.deep, "22px", "the band under the title is not capped at the ramp's depth");
    await shot(page, "fade-scrolled");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});
