// The phone's attachment tray at phone size: what a picked file looks like and
// how it moves, how the squares alone show an upload going, waiting, failed or
// refused with no line of words anywhere, how a try that failed is tried again
// without ever storing the file twice, what happens to a file the board
// refuses, and a send pressed while a file is still on its way. A copied
// server on a free port pair in a temp folder, and an owned headless Chrome at
// 375 x 812, scale 3, touch on.
const assert = require("node:assert/strict");
const { before, after, test } = require("node:test");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const puppeteer = require("puppeteer-core");
const { copyBridgeFiles, freePortPair } = require("./fixture-auth.cjs");

const ROOT = path.resolve(__dirname, "..");
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PHONE = { width: 375, height: 812, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const PDF = "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n";
let outer, uploads, origin, child, browser, cards = 0;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

before(async () => {
  outer = await mkdtemp(path.join(tmpdir(), "facilitator-phone-attachments-"));
  const app = path.join(outer, "app");
  uploads = path.join(outer, "facilitator-internal", "uploads");
  await mkdir(app);
  const port = await freePortPair();
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(source, patched);
  await writeFile(path.join(app, "server.py"), patched);
  copyBridgeFiles(app);
  for (const name of ["index.html", "m.html", "m-sw.js", "m-manifest.json", "cm-markdown.js", "compose-format.js",
    "card-markdown.js", "card-logic.js", "card-report.js", "card-tokens.css"])
    await copyFile(path.join(ROOT, name), path.join(app, name));
  await mkdir(path.join(app, "assets"));
  for (const name of await readdir(path.join(ROOT, "assets")))
    await copyFile(path.join(ROOT, "assets", name), path.join(app, "assets", name));
  await writeFile(path.join(app, "seed.json"), JSON.stringify({ title: "Tray fixture", items: [
    { id: "0", bucket: "meta", title: "Fixture card", owner: "facilitator", context: "Invented fixture" }] }));
  origin = `http://127.0.0.1:${port}`;
  child = spawn(process.env.FACILITATOR_TEST_PYTHON || "python3", [path.join(app, "server.py")], {
    cwd: app, env: { ...process.env, FACILITATOR_TEST_PORT: String(port), FACILITATOR_LOG_DIR: path.join(outer, "logs") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", bytes => { output += bytes; });
  const deadline = Date.now() + 15000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(output);
    try { if ((await fetch(origin + "/op?id=fixture-probe-01")).ok) break; } catch {}
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

// a fresh card on the phone page, with every request the page makes counted and
// the uploads held back while `hold` is set
async function openCard(title) {
  const id = (await (await fetch(origin + "/create?owner=facilitator", { method: "POST", body: title || "Tray card " + (++cards) })).json()).id;
  const page = await browser.newPage();
  page.errors = [];
  page.requests = [];
  page.hold = null;
  page.on("pageerror", error => page.errors.push(error.message));
  await page.emulate({ viewport: PHONE, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" });
  await page.setRequestInterception(true);
  page.on("request", request => {
    const url = request.url();
    if (!url.startsWith(origin + "/") && !/^(data|blob):/.test(url)) return request.abort();
    const route = new URL(url);
    page.requests.push(request.method() + " " + route.pathname + (route.pathname === "/upload" ? route.search : ""));
    if (route.pathname === "/upload" && request.method() === "POST" && page.hold) return page.hold.then(() => request.continue());
    request.continue();
  });
  await page.goto(origin + "/m?box=" + id, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(id => typeof els !== "undefined" && !!els[id]?.field, { timeout: 15000 }, id);
  await page.evaluate(id => select(id), id);
  // the backoff between tries is the messages' own; a test need not sit it out
  await page.evaluate(() => { window.backoffMs = () => 60; });
  return { page, id };
}
async function closePage(page) {
  await page.close();
  assert.deepEqual(page.errors, [], "uncaught browser error");
}
// the files the page picks, made in the page and handed to the tray
function add(page, id, files) {
  return page.evaluate((id, files) => trayAdd(id, files.map(([name, text, type]) =>
    new File([typeof text === "string" ? text : new Uint8Array(text)], name, { type }))), id, files);
}
async function settled(page, id, count) {
  await page.waitForFunction((id, count) => els[id].trayItems.length === count &&
    els[id].trayItems.every(it => !["up", "queued", "wait"].includes(it.state)), { timeout: 20000 }, id, count);
  return page.evaluate(id => els[id].trayItems.map(it => ({ name: it.name, state: it.state, url: it.url || "", tries: it.tries })), id);
}
// cut the next n upload tries in the page: the connection drops before the board hears them
function cutUploads(page, n) {
  return page.evaluate(n => {
    const open = XMLHttpRequest.prototype.open;
    let left = n;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      if (left > 0 && String(url).startsWith("/upload?")) { left--; url = "http://127.0.0.1:9/upload"; }
      return open.call(this, method, url, ...rest);
    };
  }, n);
}
const kept = async name => (await readdir(uploads)).filter(file => file.endsWith("-" + name));
// words in the typing row, the way a keystroke leaves them: the row's own input
// event runs, so the send square answers
const words = (page, id, text) => page.evaluate((id, text) => {
  els[id].ta.value = text;
  els[id].ta.dispatchEvent(new Event("input"));
}, id, text);
// the tray says nothing in words: only squares stand in it, a square carries no
// more than its kind (and size while it is idle) or the red mark, and the
// squares' row stands 12px clear of the line above the typing row, with at least
// 8px over the squares so the crosses on their corners are not clipped
async function noStatusText(page, id) {
  const seen = await page.evaluate(id => {
    const el = els[id], box = document.querySelector("#box-" + id);
    const stray = [];
    for (const node of el.tray.querySelectorAll("*")) {
      if (node.closest(".tsqkind, .tsqbang")) continue;
      for (const part of node.childNodes) if (part.nodeType === 3 && part.textContent.trim()) stray.push(part.textContent.trim());
    }
    const tray = el.tray.getBoundingClientRect(), row = box.querySelector(".bottombar").getBoundingClientRect();
    const on = el.tray.classList.contains("on");
    const squares = [...el.tray.querySelectorAll(".tsq")].map(node => node.getBoundingClientRect());
    const crosses = [...el.tray.querySelectorAll(".tsqx")].map(node => node.getBoundingClientRect());
    return { squaresOnly: [...el.tray.children].every(child => child.classList.contains("tsq")),
      noteElement: !!box.querySelector(".traynote") || el.trayNote !== undefined,
      stray, kinds: [...el.tray.querySelectorAll(".tsqkind")].map(node => node.textContent),
      marks: [...el.tray.querySelectorAll(".tsqbang")].map(node => node.textContent),
      gap: on ? Math.round((row.top - Math.max(...squares.map(s => s.bottom))) * 100) / 100 : 12,
      above: on ? Math.round((Math.min(...squares.map(s => s.top)) - tray.top) * 100) / 100 : 8,
      crossTop: on ? Math.round((Math.min(...crosses.map(x => x.top)) - tray.top) * 100) / 100 : 0 };
  }, id);
  assert.equal(seen.squaresOnly, true, "something other than a square stands in the tray");
  assert.equal(seen.noteElement, false, "the tray has a status line");
  assert.deepEqual(seen.stray, [], "words stand in the tray outside a square's kind and mark");
  for (const kind of seen.kinds) assert.match(kind, /^[A-Z0-9]+(\d+(\.\d)? (KB|MB))?$/, "a square says more than its kind");
  for (const mark of seen.marks) assert.equal(mark, "!");
  assert.equal(seen.gap, 12, "the squares are not 12px clear of the line above the typing row");
  assert.ok(seen.above >= 8, "less than 8px stands over the squares");
  assert.ok(seen.crossTop >= 0, "a cross hangs out over the tray's top edge");
}
// the squares' states, as the classes that dress them
const squares = (page, id) => page.evaluate(id => els[id].trayItems.map(it => ({ name: it.name, state: it.state,
  ring: getComputedStyle(it.sq.querySelector(".tsqring")).opacity, mark: getComputedStyle(it.sq.querySelector(".tsqbang")).display,
  tappable: it.sq.classList.contains("tappable") })), id);

test("a picked photo stands in the tray as a 64px square with its picture, a cross, and no mark once uploaded", async () => {
  const { page, id } = await openCard();
  try {
    await page.evaluate(id => { els[id].ta.value = "A draft that stays"; }, id);
    await add(page, id, [["Photo.png", [...PNG], "image/png"]]);
    const [item] = await settled(page, id, 1);
    assert.equal(item.state, "done");
    await page.waitForFunction(id => els[id].trayItems[0].sq.classList.contains("drawn"), {}, id);
    await pause(450);   // its entrance is over
    const shape = await page.evaluate(id => {
      const el = els[id], it = el.trayItems[0], face = it.sq.querySelector(".tsqface");
      const box = it.sq.getBoundingClientRect(), row = el.ta.closest(".bottombar").getBoundingClientRect();
      const x = it.sq.querySelector(".tsqx").getBoundingClientRect(), tray = el.tray.getBoundingClientRect();
      return { w: box.width, h: box.height, radius: getComputedStyle(face).borderRadius,
        cross: [x.width, x.height, Math.round(x.right - box.right), Math.round(box.top - x.top)],
        ring: getComputedStyle(it.sq.querySelector(".tsqring")).opacity,
        mark: getComputedStyle(it.sq.querySelector(".tsqbang")).display,
        above: tray.bottom <= row.top + 1, left: Math.round(box.left - row.left),
        text: el.ta.value, arrow: el.send.classList.contains("show") };
    }, id);
    assert.deepEqual([shape.w, shape.h], [64, 64]);
    assert.equal(shape.radius, "7px");
    assert.deepEqual(shape.cross, [20, 20, 6, 6]);
    assert.equal(shape.mark, "none");
    assert.ok(shape.above, "the tray is not over the typing row");
    assert.equal(shape.left, 0, "the square does not start at the row's own left edge");
    assert.equal(shape.text, "A draft that stays");
    assert.equal(shape.arrow, true);
    await page.waitForFunction(id => getComputedStyle(els[id].trayItems[0].sq.querySelector(".tsqring")).opacity === "0", {}, id);
    await noStatusText(page, id);
  } finally { await closePage(page); }
});

test("the tray moves on one beat: a square slides in, one taken out shrinks while the rest close up, the last one closes the tray", async () => {
  const { page, id } = await openCard();
  try {
    const entrance = await page.evaluate(id => {
      trayAdd(id, [new File(["%PDF-1.4 a"], "a.pdf"), new File(["%PDF-1.4 b"], "b.pdf"), new File(["%PDF-1.4 c"], "c.pdf")]);
      const run = els[id].trayItems[0].sq.getAnimations()[0];
      const frames = run.effect.getKeyframes();
      return { duration: run.effect.getTiming().duration, easing: run.effect.getTiming().easing.replace(/\s/g, ""),
        from: frames[0].transform, fromOpacity: String(frames[0].opacity), to: frames.at(-1).transform };
    }, id);
    assert.deepEqual(entrance, { duration: 400, easing: "cubic-bezier(0.22,1,0.36,1)",
      from: "translateX(-18px)", fromOpacity: "0", to: "none" });
    await settled(page, id, 3);
    await pause(450);   // the entrances are over
    const removal = await page.evaluate(id => {
      const [a, b, c] = els[id].trayItems;
      const seat = c.sq.offsetLeft, seen = c.sq.getBoundingClientRect().left;
      a.sq.querySelector(".tsqx").click();
      const leaving = a.sq.getAnimations()[0].effect.getKeyframes().at(-1);
      const slide = c.sq.getAnimations()[0]?.effect.getKeyframes()[0].transform;
      // the seat moves at once; what the eye sees starts where it was
      return { leaving: [leaving.transform, String(leaving.opacity)], parked: a.sq.classList.contains("leaving"),
        slide, moved: seat - c.sq.offsetLeft, still: Math.round(c.sq.getBoundingClientRect().left - seen),
        left: els[id].trayItems.map(it => it.name) };
    }, id);
    assert.deepEqual(removal.leaving, ["scale(0.8)", "0"]);
    assert.equal(removal.parked, true, "the leaving square kept its seat");
    assert.equal(removal.moved, 72, "the others did not close the gap");
    assert.equal(removal.still, 0, "the others jumped on the frame of the tap");
    assert.match(String(removal.slide), /^translate\(72px, ?0px\)$/, "the others jumped into the gap");
    assert.deepEqual(removal.left, ["b.pdf", "c.pdf"]);
    await page.evaluate(id => { for (const it of [...els[id].trayItems]) it.sq.querySelector(".tsqx").click(); }, id);
    const closing = await page.evaluate(id => {
      const run = els[id].tray.getAnimations().find(a => a.effect.getKeyframes().some(f => f.height));
      return run ? [run.effect.getKeyframes().at(-1).height, run.effect.getTiming().duration] : null;
    }, id);
    assert.deepEqual(closing, ["0px", 400]);
    await page.waitForFunction(id => !els[id].tray.classList.contains("on"), {}, id);
  } finally { await closePage(page); }
});

test("while a file uploads, its ring says how far it has got and no words stand under the tray", async () => {
  const { page, id } = await openCard();
  try {
    let release;
    page.hold = new Promise(resolve => { release = resolve; });
    await add(page, id, [["Recording.mov", [0, 0, 0, 20, 102, 116, 121, 112, 113, 116, 32, 32], "video/quicktime"],
                         ["Waiting.pdf", PDF, "application/pdf"]]);
    const drawn = await page.evaluate(id => {
      const el = els[id], it = el.trayItems[0];
      it.sent = 1.5e6; it.total = 4e6; it.measured = true;
      trayDraw(el);
      return { offset: it.arc.style.strokeDashoffset, up: it.sq.classList.contains("up"),
        label: it.sq.getAttribute("aria-label") };
    }, id);
    assert.equal(Number(drawn.offset).toFixed(2), (65.97 * (1 - 1.5 / 4)).toFixed(2));
    assert.equal(drawn.up, true);
    assert.equal(drawn.label, "Recording.mov: uploading");
    // the square being sent and the one waiting its turn both wear the ring, and neither the mark
    await page.waitForFunction(id => els[id].trayItems.every(it => getComputedStyle(it.sq.querySelector(".tsqring")).opacity === "1"), {}, id);
    assert.deepEqual((await squares(page, id)).map(s => [s.state, s.ring, s.mark]), [["up", "1", "none"], ["queued", "1", "none"]]);
    await noStatusText(page, id);
    const heightWhileUploading = await page.evaluate(id => els[id].tray.getBoundingClientRect().height, id);
    release();
    const items = await settled(page, id, 2);
    assert.deepEqual(items.map(it => it.state), ["done", "done"]);
    await pause(450);
    await noStatusText(page, id);
    // the tray is no taller while it uploads than once it is done
    assert.equal(await page.evaluate(id => els[id].tray.getBoundingClientRect().height, id), heightWhileUploading);
  } finally { await closePage(page); }
});

test("a try that is cut is tried again on its own, and the file is stored once", async () => {
  const { page, id } = await openCard();
  try {
    await cutUploads(page, 1);
    await page.evaluate(id => { els[id].ta.value = "Draft before upload"; }, id);
    await add(page, id, [["retry-once.pdf", PDF, "application/pdf"]]);
    const [item] = await settled(page, id, 1);
    assert.equal(item.state, "done");
    assert.equal(item.tries, 2);
    assert.match(item.url, /^\/uploads\/\d+-retry-once\.pdf$/);
    assert.equal(await page.evaluate(id => els[id].ta.value, id), "Draft before upload");
    assert.equal((await kept("retry-once.pdf")).length, 1);
    // the second try asked the board about the first before sending it again
    assert.deepEqual(page.requests.filter(r => r.includes("/upload")).map(r => r.split("?")[0]), ["GET /upload", "POST /upload"]);
  } finally { await closePage(page); }
});

test("a reply lost on the way is answered from the board's receipt, not by sending the file again", async () => {
  const { page, id } = await openCard();
  try {
    await page.evaluate(() => {
      // the board stores the first try, and its answer never reaches the phone
      const send = XMLHttpRequest.prototype.send;
      let lose = true;
      XMLHttpRequest.prototype.send = function (body) {
        if (lose) { lose = false; this.onload = () => this.onerror(); }
        return send.call(this, body);
      };
    });
    await add(page, id, [["lost-reply.pdf", PDF, "application/pdf"]]);
    const [item] = await settled(page, id, 1);
    assert.equal(item.state, "done");
    assert.equal((await kept("lost-reply.pdf")).length, 1, "the retry stored a second copy");
    assert.equal(page.requests.filter(r => r.startsWith("POST /upload")).length, 1, "the file was sent twice");
    assert.equal(page.requests.filter(r => r.startsWith("GET /upload")).length, 1);
    assert.equal(item.url, "/uploads/" + encodeURIComponent((await kept("lost-reply.pdf"))[0]));
  } finally { await closePage(page); }
});

test("after five tries a file wears the red mark and nothing else, and a tap starts another round", async () => {
  const { page, id } = await openCard();
  try {
    await cutUploads(page, 5);
    // the first wait is long enough to look at; the rest are short
    await page.evaluate(() => { window.backoffMs = () => 1500; });
    await add(page, id, [["stubborn.pdf", PDF, "application/pdf"]]);
    await page.waitForFunction(id => els[id].trayItems[0].state === "wait", {}, id);
    // waiting out a backoff: the ring turns, no mark, no words
    await page.waitForFunction(id => getComputedStyle(els[id].trayItems[0].sq.querySelector(".tsqring")).opacity === "1", {}, id);
    const [waiting] = await squares(page, id);
    assert.deepEqual([waiting.state, waiting.ring, waiting.mark, waiting.tappable], ["wait", "1", "none", true]);
    await noStatusText(page, id);
    await page.evaluate(() => { window.backoffMs = () => 60; });
    const [failed] = await settled(page, id, 1);
    assert.equal(failed.state, "failed");
    assert.equal(failed.tries, 5);
    await page.waitForFunction(id => getComputedStyle(els[id].trayItems[0].sq.querySelector(".tsqring")).opacity === "0", {}, id);
    const [marked] = await squares(page, id);
    assert.deepEqual([marked.ring, marked.mark, marked.tappable], ["0", "block", true]);
    await noStatusText(page, id);
    await page.tap(`#box-${id} .tsq .tsqface`);
    const [item] = await settled(page, id, 1);
    assert.equal(item.state, "done");
    assert.equal((await squares(page, id))[0].mark, "none");
    await noStatusText(page, id);
  } finally { await closePage(page); }
});

test("a hostile file is refused with the red mark and no words, tried once, and never sent", async () => {
  const { page, id } = await openCard();
  try {
    await add(page, id, [
      ["holiday.png", "<!doctype html><script>parent.pwned = 1</script>", "image/png"],
      ["drawing.svg", '<svg xmlns="http://www.w3.org/2000/svg" onload="parent.pwned = 2"><rect/></svg>', "image/svg+xml"],
      ["clean.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>', "image/svg+xml"],
    ]);
    const items = await settled(page, id, 3);
    assert.deepEqual(items.map(it => [it.name, it.state, it.tries]),
      [["holiday.png", "refused", 1], ["drawing.svg", "refused", 1], ["clean.svg", "done", 1]]);
    // the two the board refused wear the red mark, the clean one does not, and no line says why
    assert.deepEqual((await squares(page, id)).map(s => [s.name, s.mark, s.tappable]),
      [["holiday.png", "block", false], ["drawing.svg", "block", false], ["clean.svg", "none", false]]);
    await noStatusText(page, id);
    assert.equal(page.requests.filter(r => r.startsWith("POST /upload")).length, 3);
    assert.deepEqual((await kept("holiday.png")).concat(await kept("drawing.svg")), []);
    assert.equal(await page.evaluate(() => window.pwned), undefined);
    // a send takes the file that went and leaves the refused ones, with their marks
    await words(page, id, "Only the clean one");
    const sent = page.waitForResponse(response => new URL(response.url()).pathname === "/send");
    await page.tap(`#box-${id} .sendbtn`);
    assert.equal((await sent).status(), 200);
    await page.waitForFunction(id => els[id].trayItems.length === 2, {}, id);
    const thread = await (await fetch(origin + "/thread?box=" + id)).json();
    assert.equal(thread.messages.filter(m => m.kind === "user").at(-1).text, items[2].url + "\n\nOnly the clean one");
    await pause(450);   // the leaving square's exit is over
    assert.deepEqual((await squares(page, id)).map(s => [s.name, s.mark]), [["holiday.png", "block"], ["drawing.svg", "block"]]);
    await noStatusText(page, id);
  } finally { await closePage(page); }
});

test("a send pressed while a file uploads waits in the row and goes with it", async () => {
  const { page, id } = await openCard();
  try {
    let release;
    page.hold = new Promise(resolve => { release = resolve; });
    await add(page, id, [["Photo one.png", [...PNG], "image/png"], ["Photo two.png", [...PNG], "image/png"],
                         ["notes.pdf", PDF, "application/pdf"]]);
    await words(page, id, "Three files from the phone");
    await page.tap(`#box-${id} .sendbtn`);
    await pause(200);
    const held = await page.evaluate(id => ({ text: els[id].ta.value, hold: !!els[id].trayHold }), id);
    assert.equal(held.text, "Three files from the phone");
    assert.equal(held.hold, true);
    // a send waiting on its files says nothing: the squares still show the uploads
    assert.ok((await squares(page, id)).every(s => ["up", "queued"].includes(s.state) && s.mark === "none"));
    await noStatusText(page, id);
    assert.equal(page.requests.filter(r => r.startsWith("POST /send")).length, 0, "the words went before their files");
    const sent = page.waitForResponse(response => new URL(response.url()).pathname === "/send");
    release();
    assert.equal((await sent).status(), 200);
    await page.waitForFunction(id => els[id].ta.value === "" && els[id].trayItems.length === 0, {}, id);
    const text = (await (await fetch(origin + "/thread?box=" + id)).json()).messages.filter(m => m.kind === "user").at(-1).text;
    const [pics, doc, said] = text.split("\n\n");
    assert.match(pics, /^\/uploads\/\d+-Photo%20one\.png \/uploads\/\d+-Photo%20two\.png$/);
    assert.match(doc, /^\/uploads\/\d+-notes\.pdf$/);
    assert.equal(said, "Three files from the phone");
    // the phone's sent panel draws the two pictures as the card's grid, and the
    // document with its name
    await page.waitForFunction(id => els[id].sentwrap.querySelectorAll(".shotgrid .shot").length === 2 &&
      !!els[id].sentwrap.querySelector(".attachment-document"), {}, id);
  } finally { await closePage(page); }
});

test("a held send whose file is refused stays in the row, and the square wears the mark", async () => {
  const { page, id } = await openCard();
  try {
    let release;
    page.hold = new Promise(resolve => { release = resolve; });
    await add(page, id, [["fake.mp4", "not a video at all", "video/mp4"]]);
    await words(page, id, "Words that wait");
    await page.tap(`#box-${id} .sendbtn`);
    await pause(150);
    release();
    await settled(page, id, 1);
    await pause(200);
    assert.equal(await page.evaluate(id => els[id].ta.value, id), "Words that wait");
    assert.deepEqual((await squares(page, id)).map(s => [s.name, s.state, s.mark]), [["fake.mp4", "refused", "block"]]);
    assert.equal(await page.evaluate(id => els[id].trayHold, id), null, "the held send is still waiting on a file that will never land");
    await noStatusText(page, id);
    assert.equal(page.requests.filter(r => r.startsWith("POST /send")).length, 0);
    // taken out, the words can go on their own
    await page.tap(`#box-${id} .tsqx`);
    await page.waitForFunction(id => els[id].trayItems.length === 0, {}, id);
    const sent = page.waitForResponse(response => new URL(response.url()).pathname === "/send");
    await page.tap(`#box-${id} .sendbtn`);
    assert.equal((await sent).status(), 200);
  } finally { await closePage(page); }
});
