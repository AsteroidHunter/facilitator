const assert = require("node:assert/strict");
const { before, after, test } = require("node:test");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createServer } = require("node:http");
const { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const puppeteer = require("puppeteer-core");

const ROOT = path.resolve(__dirname, "..");
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BOX = "q";
let outer, origin, child, browser;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

before(async () => {
  outer = await mkdtemp(path.join(tmpdir(), "facilitator-chat-mark-"));
  const app = path.join(outer, "app");
  await mkdir(app);
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(source, patched);
  await writeFile(path.join(app, "server.py"), patched);
  require("./fixture-auth.cjs").copyBridgeFiles(app);
  for (const name of ["index.html", "page.html", "m.html", "m-sw.js", "m-manifest.json", "sw.js", "manifest.json", "cm-markdown.js",
    "compose-format.js", "card-markdown.js", "card-logic.js", "card-report.js", "card-tokens.css"])
    await copyFile(path.join(ROOT, name), path.join(app, name));
  await mkdir(path.join(app, "assets"));
  for (const name of await readdir(path.join(ROOT, "assets")))
    await copyFile(path.join(ROOT, "assets", name), path.join(app, "assets", name));
  await writeFile(path.join(app, "seed.json"), JSON.stringify({ title: "Chat mark fixture", items: [
    { id: "0", bucket: "meta", title: "Fixture card", owner: "facilitator", context: "Invented fixture" },
    { id: "q", bucket: "meta", title: "Fixture chat", owner: "qchat", context: "Invented chat" },
    { id: "1.1", bucket: "now", title: "Fixture lane", owner: "pastureland", context: "Invented lane" },
  ] }));
  origin = `http://127.0.0.1:${port}`;
  child = spawn(process.env.FACILITATOR_TEST_PYTHON || "python3", [path.join(app, "server.py")], {
    cwd: app, env: { ...process.env, FACILITATOR_TEST_PORT: String(port), FACILITATOR_LOG_DIR: path.join(outer, "logs") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", bytes => { output += bytes; });
  const deadline = Date.now() + 10000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(output);
    try { if ((await fetch(origin + "/state")).ok) break; } catch (_) {}
    if (Date.now() > deadline) throw new Error("Fixture did not start: " + output);
    await pause(25);
  }
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true,
    args: ["--disable-background-networking", "--no-first-run"] });
});

after(async () => {
  if (browser) await browser.close();
  if (child && child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
  if (outer) await rm(outer, { recursive: true, force: true });
});

// the thread's lane and box are empty on this board, so the page's own sends and
// reads are pointed at the fixture's chat card here, in the page only, and the
// thread's own teardown is held off. net.send holds what the next sends do, one
// each: down (no answer), lose (the board gets it, the answer is lost), refuse
// (409) or stall (nothing until the try gives up). net.op is "down" while the
// board's receipt lookup is out of reach
async function wire(page) {
  await page.evaluate(box => {
    chatOff = () => {};
    const real = window.fetch.bind(window);
    const net = window.__net = { send: [], op: null, sends: [], asked: 0, replies: [] };
    window.fetch = async (url, options) => {
      const text = String(url).replace(/^(\/(?:send|thread)\?box=)(&|$)/, "$1" + box + "$2");
      if (text.startsWith("/op?")) {
        net.asked++;
        if (net.op === "down") throw new TypeError("Failed to fetch");
      }
      if (!text.startsWith("/send?")) return real(text, options);
      net.sends.push(text);
      const how = net.send.shift() || "pass";
      if (how === "down") throw new TypeError("Failed to fetch");
      if (how === "refuse") return new Response(JSON.stringify({ error: "refused" }), { status: 409 });
      if (how === "stall") await new Promise((_, no) => options.signal.addEventListener("abort", () => no(options.signal.reason)));
      const response = await real(text, options);
      net.replies.push(await response.clone().json().catch(() => null));
      if (how === "lose") throw new TypeError("Failed to fetch");
      return response;
    };
  }, BOX);
}
async function openThread() {
  const page = await browser.newPage();
  page.fixtureErrors = [];
  page.on("pageerror", error => page.fixtureErrors.push(error.message));
  await page.setViewport({ width: 1512, height: 982 });
  await page.setRequestInterception(true);
  page.on("request", request => {
    const url = request.url();
    if (url.startsWith(origin + "/") || /^(data|blob):/.test(url)) request.continue();
    else request.abort();
  });
  // magic box 3 is hidden until a tab reveals it, which gives the thread a place on screen
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem("show.facilitator.magic3", "1"); } catch (e) {} });
  await page.goto(origin + "/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof lastState !== "undefined" && lastState !== null);
  await wire(page);
  await mount(page);
  return page;
}
async function mount(page, keep) {
  await page.evaluate(keep => {
    chatBuild();
    if (!keep) { c3Out = []; localStorage.removeItem("c3out"); }
    c3Msgs = []; c3Sig = ""; chatDraw(true);
  }, !!keep);
}
async function closePage(page) {
  await page.evaluate(() => localStorage.removeItem("c3out")).catch(() => {});
  await page.close();
  assert.deepEqual(page.fixtureErrors, [], "uncaught browser error");
}
const send = (page, words, ...how) => page.evaluate((words, how) => {
  __net.send.push(...how);
  document.querySelector("#magic3 textarea").value = words;
  return chatSend();
}, words, how);
const press = (page, which) => page.click("#magic3 .c3evt.failed " + (which === "arrow" ? ".answretry" : ".answcross"));
const marked = page => page.evaluate(() => !!document.querySelector("#magic3 .c3evt.failed .answmark"));
const settled = page => page.waitForFunction(() => !document.querySelector("#magic3 .c3evt.failed") && c3Out.length === 0, { timeout: 8000, polling: 30 });
const standing = (page, words) => page.waitForFunction(words => c3Msgs.some(m => m.kind === "user" && m.text === words), { timeout: 6000, polling: 30 }, words);
const field = page => page.evaluate(() => document.querySelector("#magic3 textarea").value);
const net = page => page.evaluate(() => ({ sends: __net.sends, asked: __net.asked, replies: __net.replies }));
const opOf = text => new URL("http://x" + text).searchParams.get("op");
async function copies(words) {
  const thread = await (await fetch(`${origin}/thread?box=${BOX}&n=60`)).json();
  return thread.messages.filter(m => m.kind === "user" && m.text === words).length;
}

test("a failed line wears the red round mark with a small cross and nothing else", async () => {
  const page = await openThread();
  try {
    const words = "Running late, start without me";
    await send(page, words, "down");
    await pause(400);
    const look = await page.evaluate(() => {
      const row = [...document.querySelectorAll("#magic3 .c3evt.failed .c3row.user")].pop();
      const arrow = row.querySelector(".answretry"), cross = row.querySelector(".answcross"), mark = row.querySelector(".answmark");
      const box = node => { const r = node.getBoundingClientRect(); return { w: r.width, h: r.height, left: r.left, right: r.right, mid: r.top + r.height / 2 }; };
      const probe = document.createElement("i");
      probe.style.background = "var(--accent)"; document.body.appendChild(probe);
      const accent = getComputedStyle(probe).backgroundColor; probe.remove();
      const paint = node => { const s = getComputedStyle(node); return [s.backgroundColor, s.color, s.borderColor, s.boxShadow].join(" "); };
      return {
        row: box(row), arrow: box(arrow), cross: box(cross), colour: getComputedStyle(arrow).backgroundColor,
        padding: getComputedStyle(row).paddingRight, markText: mark.innerText.trim(), buttons: mark.querySelectorAll("button").length,
        glyph: !!arrow.querySelector("svg polyline") && !!arrow.querySelector("svg path"),
        oldMarks: document.querySelectorAll("#magic3 .c3badge, #magic3 .c3fail").length,
        text: document.querySelector("#magic3").innerText.replace(/\s+/g, " ").trim(),
        purple: paint(arrow).includes(accent) || paint(cross).includes(accent) || paint(mark).includes(accent),
      };
    });
    assert.equal(look.colour, "rgb(255, 59, 48)");
    assert.deepEqual([look.arrow.w, look.arrow.h], [18, 18]);
    assert.ok(look.cross.w < look.arrow.w && look.cross.right <= look.arrow.left + 0.5, "the cross is the small one beside the arrow");
    assert.equal(Math.round((look.row.right - look.arrow.right) * 10) / 10, 2);
    assert.ok(Math.abs(look.arrow.mid - look.row.mid) < 1.5, "the mark stands at the row's middle");
    assert.equal(look.padding, "46px");
    assert.ok(look.glyph, "the arrow is the circular one");
    assert.equal(look.markText, ""); assert.equal(look.buttons, 2);
    assert.equal(look.oldMarks, 0, "no old badge or label");
    assert.equal(look.purple, false);
    assert.ok(look.text.includes(words));
    assert.doesNotMatch(look.text, /not delivered|failed|try again|couldn.t|error|not sent|tap/i);
    assert.equal(await copies(words), 0);
  } finally { await closePage(page); }
});

test("the arrow sends a failed line again under the same operation id and it lands once", async () => {
  const page = await openThread();
  try {
    const words = "Arrow lands it";
    await send(page, words, "down");
    await press(page, "arrow");
    await settled(page); await standing(page, words);
    const seen = await net(page);
    assert.equal(seen.sends.length, 2);
    assert.ok(opOf(seen.sends[0]) && opOf(seen.sends[0]) === opOf(seen.sends[1]), "both tries carry one id");
    assert.equal(await copies(words), 1);
    assert.equal(await page.evaluate(() => document.querySelectorAll("#magic3 .answmark").length), 0);
  } finally { await closePage(page); }
});

test("the arrow after a lost answer never duplicates the line", async () => {
  const page = await openThread();
  try {
    const words = "Lost answer, arrow";
    await send(page, words, "lose");
    assert.equal(await marked(page), true);
    assert.equal(await copies(words), 1, "the lost-answer try reached the board");
    await press(page, "arrow");
    await settled(page); await standing(page, words);
    const seen = await net(page);
    assert.equal(seen.sends.length, 2);
    assert.equal(opOf(seen.sends[0]), opOf(seen.sends[1]));
    assert.equal(seen.replies.at(-1).replayed, true, "the board answered from its receipt");
    assert.equal(await copies(words), 1);
  } finally { await closePage(page); }
});

test("a refused line shows the same mark, the arrow does nothing and the cross gives the words back without asking", async () => {
  const page = await openThread();
  try {
    const words = "Turned down outright";
    await send(page, words, "refuse");
    assert.equal(await marked(page), true);
    assert.equal(await page.evaluate(() => c3Out[0].refused), true);
    const before = (await net(page)).sends.length;
    await press(page, "arrow"); await pause(500);
    assert.equal((await net(page)).sends.length, before, "the arrow sent a refused line");
    assert.equal(await marked(page), true);
    await press(page, "cross"); await settled(page);
    assert.equal(await field(page), words);
    assert.equal((await net(page)).asked, 0, "a refused line was asked about");
    assert.equal(await copies(words), 0);
  } finally { await closePage(page); }
});

test("the cross asks the board first: nothing while it is unreachable, the line stands if it landed, the words come back if it did not", async () => {
  const page = await openThread();
  try {
    const landed = "Landed, answer lost", missed = "Never reached the board";
    await send(page, landed, "lose");
    await page.evaluate(() => { __net.op = "down"; });
    await press(page, "cross"); await pause(500);
    assert.equal(await marked(page), true, "the cross acted with the board unreachable");
    assert.equal(await field(page), "");
    assert.ok((await net(page)).asked >= 1);
    await page.evaluate(() => { __net.op = null; });
    await press(page, "cross");
    await settled(page); await standing(page, landed);
    assert.equal(await field(page), "", "words were taken back from a line that landed");
    assert.equal(await copies(landed), 1);
    assert.equal((await net(page)).sends.length, 1, "the cross sent the line again");

    await send(page, missed, "down");
    await press(page, "cross"); await settled(page);
    assert.equal(await field(page), missed);
    assert.equal(await copies(missed), 0);
  } finally { await closePage(page); }
});

test("the cross puts the words after a draft, never over it, and gives picked files back to the tray", async () => {
  const page = await openThread();
  try {
    await page.evaluate(() => {
      const wired = window.fetch;
      window.fetch = (url, options) => String(url).startsWith("/upload?")
        ? Promise.resolve(new Response(JSON.stringify({ error: "interrupted" }), { status: 503 })) : wired(url, options);
      c3Pick([new File(["%PDF-1.4 fixture"], "back.pdf", { type: "application/pdf" })]);
    });
    await send(page, "Words with a file");
    assert.equal(await marked(page), true);
    assert.equal(await page.evaluate(() => c3Files.length), 0);
    await page.evaluate(() => { document.querySelector("#magic3 textarea").value = "A draft in progress"; });
    await press(page, "cross"); await settled(page);
    assert.equal(await field(page), "A draft in progress\n\nWords with a file");
    assert.deepEqual(await page.evaluate(() => c3Files.map(f => f.name)), ["back.pdf"]);
    assert.equal(await page.evaluate(() => document.querySelectorAll("#magic3 .c3thumb").length), 1);
  } finally { await closePage(page); }
});

test("a send the board never answers gives up at 10 seconds and shows the mark", async () => {
  const page = await openThread();
  try {
    const words = "Board silent";
    const started = Date.now();
    await send(page, words, "stall");
    const took = Date.now() - started;
    assert.ok(took >= 9500 && took <= 12000, "gave up after " + took + " ms");
    assert.equal(await marked(page), true);
    assert.equal(await copies(words), 0);
  } finally { await closePage(page); }
});

test("after a reload the failed line keeps its id and its refusal, and the arrow sends under that same id", async () => {
  const page = await openThread();
  try {
    await send(page, "Kept across a reload", "down");
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("c3out")));
    assert.equal(stored.length, 1);
    assert.ok(stored[0].op);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof lastState !== "undefined" && lastState !== null);
    await wire(page); await mount(page, true);
    await page.waitForSelector("#magic3 .c3evt.failed .answmark");
    await press(page, "arrow");
    await settled(page); await standing(page, "Kept across a reload");
    const seen = await net(page);
    assert.equal(opOf(seen.sends.at(-1)), stored[0].op);
    assert.equal(await copies("Kept across a reload"), 1);

    await send(page, "Refused and kept", "refuse");
    const refused = await page.evaluate(() => JSON.parse(localStorage.getItem("c3out")));
    assert.equal(refused[0].refused, true);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof lastState !== "undefined" && lastState !== null);
    await wire(page); await mount(page, true);
    await page.waitForSelector("#magic3 .c3evt.failed .answmark");
    await press(page, "arrow"); await pause(500);
    assert.equal((await net(page)).sends.length, 0, "a refused line was sent again after a reload");
  } finally { await closePage(page); }
});
