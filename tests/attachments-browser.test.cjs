const assert = require("node:assert/strict");
const { before, after, test } = require("node:test");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createServer, request } = require("node:http");
const { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const puppeteer = require("puppeteer-core");
const markdown = require("../card-markdown.js");

const ROOT = path.resolve(__dirname, "..");
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const GIF = Buffer.from("R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==", "base64");
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
const WAV = Buffer.alloc(44 + 8000);
WAV.write("RIFF", 0); WAV.writeUInt32LE(WAV.length - 8, 4); WAV.write("WAVEfmt ", 8);
WAV.writeUInt32LE(16, 16); WAV.writeUInt16LE(1, 20); WAV.writeUInt16LE(1, 22);
WAV.writeUInt32LE(8000, 24); WAV.writeUInt32LE(8000, 28); WAV.writeUInt16LE(1, 32); WAV.writeUInt16LE(8, 34);
WAV.write("data", 36); WAV.writeUInt32LE(8000, 40); WAV.fill(128, 44);
let outer, app, origin, child, browser;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function post(route, body) {
  return fetch(origin + route, { method: "POST", body });
}
async function upload(name, bytes = PDF) {
  const response = await post("/upload?name=" + encodeURIComponent(name), bytes);
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()).url;
}
async function createCard(title) {
  return (await (await post("/create?owner=facilitator", title)).json()).id;
}
async function openPage(route, phone = false) {
  const page = await browser.newPage();
  page.fixtureErrors = [];
  page.on("pageerror", error => page.fixtureErrors.push(error.message));
  await page.setViewport(phone ? { width: 390, height: 844, isMobile: true, hasTouch: true } : { width: 1400, height: 1000 });
  await page.setRequestInterception(true);
  page.on("request", request => {
    const url = request.url();
    if (url.startsWith(origin + "/") || /^(data|blob):/.test(url)) request.continue();
    else request.abort();
  });
  await page.goto(origin + route, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof lastState !== "undefined" && lastState !== null);
  return page;
}
async function closePage(page) {
  await page.close();
  assert.deepEqual(page.fixtureErrors, [], "uncaught browser error");
}
async function openCard(phone) {
  const id = await createCard("Attachment fixture " + (phone ? "phone" : "desktop"));
  const page = await openPage(phone ? "/m?box=" + id : "/", phone);
  await page.waitForFunction(id => !!els[id], {}, id);
  await page.evaluate(id => select(id), id);
  await page.waitForFunction(id => !!els[id].field?.view, {}, id);
  return { page, id };
}
async function transfer(page, id, eventName, name, type, bytes = [1, 2, 3]) {
  await page.evaluate(({ id, eventName, name, type, bytes }) => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array(bytes)], name, { type }));
    const target = id ? els[id].field?.view?.contentDOM || els[id].ta : document.querySelector("#magic3 textarea");
    const event = eventName === "drop" ? new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true })
      : new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
  }, { id, eventName, name, type, bytes });
}

before(async () => {
  outer = await mkdtemp(path.join(tmpdir(), "facilitator-attachments-"));
  app = path.join(outer, "app");
  await mkdir(app);
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(source, patched);
  await writeFile(path.join(app, "server.py"), patched);
  for (const name of ["index.html", "page.html", "m.html", "m-sw.js", "m-manifest.json", "cm-markdown.js",
    "compose-format.js", "card-markdown.js", "card-logic.js", "card-report.js", "card-tokens.css"])
    await copyFile(path.join(ROOT, name), path.join(app, name));
  await mkdir(path.join(app, "assets"));
  for (const name of await readdir(path.join(ROOT, "assets")))
    await copyFile(path.join(ROOT, "assets", name), path.join(app, "assets", name));
  await writeFile(path.join(app, "seed.json"), JSON.stringify({ title: "Attachment fixture", items: [
    { id: "0", bucket: "meta", title: "Fixture card", owner: "facilitator", context: "Invented fixture" },
    { id: "q", bucket: "meta", title: "Fixture chat", owner: "qchat", context: "Invented chat" },
    { id: "1.1", bucket: "now", title: "Fixture lane", owner: "pastureland", context: "Invented lane" },
  ] }));
  await writeFile(path.join(app, "run.config.json"), JSON.stringify({ lanes: [{ owner: "facilitator", dir: app }] }));
  await mkdir(path.join(app, "facilitator-internal"));
  await writeFile(path.join(app, "facilitator-internal", "lane.png"), PNG);
  await writeFile(path.join(app, "facilitator-internal", "lane.pdf"), PDF);
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

test("type policy uses extensions, MIME fallback and the existing size limit", () => {
  for (const ext of Object.keys(markdown.ATTACHMENT_TYPES)) {
    const info = markdown.attachmentFile({ name: "file." + ext.toUpperCase(), type: "", size: 5 });
    assert.equal(info.error, "", ext);
    assert.ok(markdown.ATTACHMENT_ACCEPT.split(",").includes("." + ext));
  }
  assert.equal(markdown.attachmentFile({ name: "clipboard", type: "audio/x-wav", size: 5 }).name, "clipboard.wav");
  assert.match(markdown.attachmentFile({ name: "file.html", type: "application/pdf", size: 5 }).error, /Unsupported/);
  assert.match(markdown.attachmentFile({ name: "file.constructor", size: 5 }).error, /Unsupported/);
  assert.equal(markdown.attachmentFile({ name: "file.pdf", size: 32 * 1024 * 1024 }).error, "");
  assert.match(markdown.attachmentFile({ name: "file.pdf", size: 32 * 1024 * 1024 + 1 }).error, /32 MiB/);
});

test("every allowed type uploads and retrieves exact bytes with its declared content type", async () => {
  for (const [ext, info] of Object.entries(markdown.ATTACHMENT_TYPES)) {
    const bytes = ext === "png" ? PNG : ext === "gif" ? GIF : ext === "wav" ? WAV : Buffer.from("fixture " + ext);
    const url = await upload("Fixture file." + ext.toUpperCase(), bytes);
    assert.match(url, /^\/uploads\/\d+-Fixture%20file\./);
    const response = await fetch(origin + url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), info[1]);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.match(response.headers.get("content-disposition"), new RegExp("^" + (/^docx?$/.test(ext) ? "attachment" : "inline")));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  }
});

test("media byte ranges support seeking, and download links request attachment disposition", async () => {
  const url = await upload("voice.wav", WAV);
  const response = await fetch(origin + url, { headers: { Range: "bytes=44-143" } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), `bytes 44-143/${WAV.length}`);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), WAV.subarray(44, 144));
  const download = await fetch(origin + url + "?download=1");
  assert.match(download.headers.get("content-disposition"), /^attachment; filename="voice.wav"/);
});

test("server keeps the 32 MiB boundary and refuses unsupported, empty and escaped paths", async () => {
  assert.equal((await post("/upload?name=empty.pdf", Buffer.alloc(0))).status, 400);
  assert.equal((await post("/upload?name=unsafe.html", PDF)).status, 415);
  assert.equal((await post("/upload?name=unsafe.docm", PDF)).status, 415);
  const cap = 32 * 1024 * 1024;
  const refused = await new Promise((resolve, reject) => {
    const req = request(origin + "/upload?name=large.pdf", { method: "POST", headers: { "Content-Length": String(cap + 1) } }, response => {
      response.resume(); response.on("end", () => resolve(response.statusCode));
    });
    req.on("error", reject);
    req.flushHeaders();
  });
  assert.equal(refused, 413);
  const url = await upload("boundary.pdf", Buffer.alloc(cap, 13));
  const response = await fetch(origin + url, { headers: { Range: `bytes=${cap - 1}-` } });
  assert.equal(response.status, 206);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from([13]));
  const uploads = path.join(outer, "facilitator-internal", "uploads");
  await writeFile(path.join(outer, "outside.pdf"), PDF);
  await symlink(path.join(outer, "outside.pdf"), path.join(uploads, "escape.pdf"));
  assert.equal((await fetch(origin + "/uploads/escape.pdf")).status, 404);
  assert.equal((await fetch(origin + "/uploads/nested%2Fescape.pdf")).status, 404);
  assert.equal((await fetch(origin + "/uploads/unsafe.html")).status, 404);
});

test("legacy uploaded images still resolve and lane panels remain image-only", async () => {
  await mkdir(path.join(app, "uploads"));
  await writeFile(path.join(app, "uploads", "legacy.gif"), GIF);
  assert.deepEqual(Buffer.from(await (await fetch(origin + "/uploads/legacy.gif")).arrayBuffer()), GIF);
  assert.equal((await fetch(origin + "/laneimg/facilitator/lane.png")).status, 200);
  assert.equal((await fetch(origin + "/laneimg/facilitator/lane.pdf")).status, 404);
});

for (const phone of [false, true]) {
  test(`${phone ? "phone" : "desktop"} picker, paste and drop preserve the draft and send raw upload URLs`, async () => {
    const { page, id } = await openCard(phone);
    try {
      await page.evaluate(id => {
        const ta = els[id].ta;
        ta.value = "Keep this draft  "; ta.focus(); ta.setSelectionRange(2, 6, "backward");
        ta.dispatchEvent(new Event("input"));
      }, id);
      const filename = path.join(outer, "Picked report.docx");
      await writeFile(filename, Buffer.from("PK invented document"));
      const chooser = page.waitForFileChooser();
      await page.click(`#box-${id} .clipbtn`);
      await (await chooser).accept([filename]);
      await page.waitForFunction(id => els[id].ta.value.includes(".docx"), {}, id);
      const selected = await page.evaluate(id => ({ text: els[id].ta.value, start: els[id].ta.selectionStart, end: els[id].ta.selectionEnd }), id);
      assert.ok(selected.text.startsWith("Keep this draft  \n"));
      assert.deepEqual([selected.start, selected.end], [2, 6]);
      await transfer(page, id, "drop", "dropped.mp4", "video/mp4");
      await page.waitForFunction(id => els[id].ta.value.includes(".mp4"), {}, id);
      await transfer(page, id, "paste", "pasted.wav", "audio/wav", [...WAV]);
      await page.waitForFunction(id => els[id].ta.value.includes(".wav"), {}, id);
      const raw = await page.evaluate(id => els[id].ta.value.trim(), id);
      const sent = page.waitForResponse(response => new URL(response.url()).pathname === "/send" && new URL(response.url()).searchParams.get("box") === id);
      await page.waitForFunction(id => els[id].send.classList.contains("show"), {}, id);
      await page.click(`#box-${id} .sendbtn`);
      assert.equal((await sent).status(), 200);
      await page.waitForFunction(id => els[id].ta.value === "", {}, id);
      const thread = await (await fetch(origin + "/thread?box=" + id)).json();
      assert.equal(thread.messages.filter(m => m.kind === "user").at(-1).text, raw);
      assert.equal(raw.split("\n").filter(line => line.startsWith("/uploads/")).length, 3);
    } finally { await closePage(page); }
  });

  test(`${phone ? "phone" : "desktop"} shows unsupported and oversized errors without changing the draft`, async () => {
    const { page, id } = await openCard(phone);
    try {
      await page.evaluate(id => { els[id].ta.value = "Still here"; }, id);
      await transfer(page, id, "drop", "unsupported.html", "text/html");
      await page.waitForFunction(id => els[id].box.querySelector(".attachment-status")?.textContent.includes("Unsupported"), {}, id);
      await page.evaluate(id => attach([new File([new Uint8Array(32 * 1024 * 1024 + 1)], "huge.pdf", { type: "application/pdf" })], els[id].ta), id);
      assert.match(await page.$eval(`#box-${id} .attachment-status`, el => el.textContent), /32 MiB/);
      assert.equal(await page.evaluate(id => els[id].ta.value, id), "Still here");
    } finally { await closePage(page); }
  });
}

test("document and media markup is bounded, escaped and playable in the owned browser", async () => {
  const page = await openPage("/");
  try {
    await page.click("body");
    const audio = await upload("voice.wav", WAV);
    const png = await upload("image.png", PNG), gif = await upload("animated.gif", GIF), pdf = await upload("report.pdf", PDF);
    const videoBytes = await page.evaluate(async () => {
      const canvas = document.createElement("canvas"); canvas.width = 32; canvas.height = 32;
      const stream = canvas.captureStream(10), recorder = new MediaRecorder(stream, { mimeType: "video/webm" }), chunks = [];
      recorder.ondataavailable = e => chunks.push(e.data);
      const stopped = new Promise(resolve => { recorder.onstop = resolve; });
      recorder.start(); canvas.getContext("2d").fillRect(0, 0, 32, 32);
      await new Promise(resolve => setTimeout(resolve, 220)); recorder.stop(); await stopped;
      stream.getTracks().forEach(track => track.stop());
      return [...new Uint8Array(await new Blob(chunks).arrayBuffer())];
    });
    const video = await upload("clip.webm", Buffer.from(videoBytes));
    const source = [audio, video, pdf, png + " " + gif, "/uploads/%3Cimg%20onerror%3Dalert(1)%3E.docx"].join("\n\n");
    const shape = await page.evaluate(async source => {
      const host = document.createElement("div"); host.className = "cardmd"; host.style.width = "280px";
      host.innerHTML = CardMarkdown.render(source); document.body.prepend(host);
      const audio = host.querySelector("audio"), video = host.querySelector("video");
      await Promise.all([audio, video].map(media => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Media metadata timed out")), 8000);
        const ready = () => { clearTimeout(timer); resolve(); };
        if (media.readyState >= 1) ready();
        else { media.onloadedmetadata = ready; media.onerror = () => { clearTimeout(timer); reject(new Error("Media fixture failed")); }; }
      })));
      await audio.play(); await video.play();
      const result = { playing: [!audio.paused, !video.paused], duration: audio.duration,
        controls: [audio.controls, video.controls], autoplay: [audio.autoplay, video.autoplay], inline: video.playsInline,
        images: [...host.querySelectorAll("img")].map(img => img.getAttribute("src")),
        grid: !!host.querySelector(".shotgrid"), documents: host.querySelectorAll(".attachment-document").length,
        downloads: host.querySelectorAll("a[download]").length, unsafe: host.querySelectorAll("[onerror], script").length,
        names: [...host.querySelectorAll(".attachment-name")].map(el => el.textContent),
        overflow: [...host.querySelectorAll("audio, video, .attachment")].some(el => el.getBoundingClientRect().width > 281) };
      audio.pause(); video.pause(); return result;
    }, source);
    assert.deepEqual(shape.playing, [true, true]); assert.equal(shape.duration, 1);
    assert.deepEqual(shape.controls, [true, true]); assert.deepEqual(shape.autoplay, [false, false]); assert.equal(shape.inline, true);
    assert.deepEqual(shape.images, [png, gif]); assert.equal(shape.grid, true); assert.equal(shape.documents, 2);
    assert.equal(shape.downloads, 4); assert.equal(shape.unsafe, 0); assert.equal(shape.overflow, false);
    assert.ok(shape.names.includes("<img onerror=alert(1)>.docx"));
  } finally { await closePage(page); }
});

test("chat stages mixed files and retries only incomplete uploads before sending raw URLs", async () => {
  const page = await openPage("/");
  try {
    await page.evaluate(() => { activeOwner = C3_LANE; chatBuild(); c3Out = []; c3Msgs = []; c3Sig = ""; chatDraw(true); });
    const filename = path.join(outer, "chat-video.mp4");
    await writeFile(filename, Buffer.from("Invented video upload"));
    const chooser = page.waitForFileChooser();
    await page.click("#magic3 .c3attach");
    await (await chooser).accept([filename]);
    await transfer(page, null, "paste", "chat-report.pdf", "application/pdf", [...PDF]);
    await transfer(page, null, "drop", "chat.gif", "image/gif", [...GIF]);
    assert.equal(await page.$$eval("#magic3 .c3thumb", els => els.length), 3);
    assert.equal(await page.$$eval("#magic3 .c3thumb img", els => els.length), 1);
    assert.equal(await page.$$eval("#magic3 .c3filename", els => els.length), 2);
    const outcome = await page.evaluate(async () => {
      const realFetch = window.fetch, attempts = [];
      let failedOnce = false;
      window.fetch = async (url, options) => {
        if (String(url).startsWith("/upload?")) {
          const name = new URL(url, location.href).searchParams.get("name"); attempts.push(name);
          if (name === "chat-report.pdf" && !failedOnce) {
            failedOnce = true; return new Response(JSON.stringify({ error: "Fixture interrupted upload" }), { status: 503 });
          }
        }
        return realFetch(url, options);
      };
      document.querySelector("#magic3 textarea").value = "Keep the chat words";
      await chatSend();
      const out = c3Out[0];
      const failed = out.failed, urlsAfterFailure = out.urls.slice();
      const fileKinds = [...document.querySelectorAll("#magic3 .c3msg video, #magic3 .attachment-name")].map(el => el.tagName);
      out.failed = false; await chatPost(out); window.fetch = realFetch;
      return { failed, urlsAfterFailure, attempts, fileKinds, urls: out.urls, remaining: c3Out.length,
        notice: document.querySelector("#magic3 .attachment-status")?.textContent };
    });
    assert.equal(outcome.failed, true); assert.equal(outcome.urlsAfterFailure.length, 1);
    assert.deepEqual(outcome.attempts, ["chat-video.mp4", "chat-report.pdf", "chat-report.pdf", "chat.gif"]);
    assert.ok(outcome.fileKinds.includes("VIDEO")); assert.equal(outcome.remaining, 0); assert.equal(outcome.notice, "");
    const thread = await (await fetch(origin + "/thread?box=q")).json();
    assert.equal(thread.messages.filter(m => m.kind === "user").at(-1).text, outcome.urls.concat("Keep the chat words").join("\n"));
  } finally { await closePage(page); }
});

test("a failed card upload keeps the draft and succeeds when the file is selected again", async () => {
  const { page, id } = await openCard(true);
  try {
    const result = await page.evaluate(async id => {
      const ta = els[id].ta, realFetch = window.fetch;
      ta.value = "Draft before upload";
      const file = new File(["%PDF fixture"], "retry.pdf", { type: "application/pdf" });
      window.fetch = async url => String(url).startsWith("/upload?")
        ? new Response(JSON.stringify({ error: "Fixture upload unavailable" }), { status: 503 }) : realFetch(url);
      await attach([file], ta);
      const kept = ta.value, error = els[id].box.querySelector(".attachment-status").textContent;
      window.fetch = realFetch; await attach([file], ta);
      return { kept, error, after: ta.value, cleared: els[id].box.querySelector(".attachment-status").textContent };
    }, id);
    assert.equal(result.kept, "Draft before upload"); assert.match(result.error, /Fixture upload unavailable/);
    assert.match(result.after, /^Draft before upload\n\/uploads\/.*retry\.pdf\n$/); assert.equal(result.cleared, "");
  } finally { await closePage(page); }
});

test("a reloaded chat cannot silently send a file set that never finished uploading", async () => {
  const page = await openPage("/");
  try {
    await page.evaluate(() => {
      c3Out = [{ id: "incomplete", at: Date.now(), text: "Keep the text", failed: true,
        urls: ["/uploads/already.pdf"], files: [new File(["1"], "one.pdf"), new File(["2"], "two.pdf")], shots: [] }];
      c3Save();
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => lastState !== null);
    const result = await page.evaluate(async () => {
      activeOwner = C3_LANE; chatBuild();
      const realFetch = window.fetch;
      let sent = false;
      window.fetch = async (...args) => { if (String(args[0]).startsWith("/send")) sent = true; return realFetch(...args); };
      const out = c3Out.find(o => o.id === "incomplete");
      await chatPost(out); window.fetch = realFetch;
      return { sent, failed: out.failed, text: out.text, missing: out.missingFiles,
        notice: document.querySelector("#magic3 .attachment-status").textContent };
    });
    assert.equal(result.missing, 1); assert.equal(result.sent, false);
    assert.equal(result.failed, true); assert.equal(result.text, "Keep the text");
    assert.match(result.notice, /Attach them again/);
  } finally { await closePage(page); }
});

test("the document page's existing drop path accepts a PDF and preserves raw message text", async () => {
  const id = await createCard("Document page attachment fixture");
  const page = await openPage("/page?doc=1");
  try {
    await page.waitForFunction(id => !!els[id], {}, id);
    await page.evaluate(({ id, bytes }) => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array(bytes)], "document-drop.pdf", { type: "application/pdf" }));
      els[id].ta.value = "Document draft";
      els[id].ta.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
    }, { id, bytes: [...PDF] });
    await page.waitForFunction(id => els[id].ta.value.includes("document-drop.pdf"), {}, id);
    const raw = await page.evaluate(id => els[id].ta.value, id);
    assert.match(raw, /^Document draft\n\/uploads\/.*document-drop\.pdf\n$/);
    const html = await page.evaluate(raw => CardMarkdown.render(raw), raw);
    assert.match(html, /attachment-document/); assert.doesNotMatch(html, /<img/);
  } finally { await closePage(page); }
});

for (const phone of [false, true]) {
  test(`${phone ? "phone" : "desktop"} attachment replies fit the card and expose filename, open and download links`, async () => {
    const id = await createCard("Files in a reply");
    const pdf = await upload("Meeting report.pdf", PDF);
    const doc = await upload("A long document filename that wraps inside the phone card.docx", Buffer.from("PK fixture"));
    const audio = await upload("Voice memo.wav", WAV);
    const gif = await upload("Animated image.gif", GIF);
    assert.equal((await post("/reply?box=" + id, ["Files for review:", pdf, doc, audio, gif].join("\n\n"))).status, 200);
    const page = await openPage(phone ? "/m?box=" + id : "/", phone);
    try {
      await page.waitForFunction(id => !!els[id], {}, id);
      await page.evaluate(id => select(id), id);
      await page.waitForFunction(id => els[id].reply.querySelectorAll(".attachment").length === 3, {}, id);
      const shape = await page.evaluate(id => {
        const reply = els[id].reply, box = reply.getBoundingClientRect();
        return { names: [...reply.querySelectorAll(".attachment-name")].map(el => el.textContent),
          open: [...reply.querySelectorAll(".attachment-links a:not([download])")].map(el => el.getAttribute("href")),
          download: [...reply.querySelectorAll("a[download]")].map(el => el.getAttribute("href")),
          audio: reply.querySelector("audio").controls, gif: reply.querySelector("img").getAttribute("src"),
          overflow: [...reply.querySelectorAll(".attachment, .attachment-name, audio")].some(el => {
            const b = el.getBoundingClientRect(); return b.left < box.left - 1 || b.right > box.right + 1;
          }) };
      }, id);
      assert.deepEqual(shape.names, ["Meeting report.pdf", "A long document filename that wraps inside the phone card.docx", "Voice memo.wav"]);
      assert.deepEqual(shape.open, [pdf, doc, audio]); assert.equal(shape.download.length, 3);
      assert.equal(shape.audio, true); assert.equal(shape.gif, gif); assert.equal(shape.overflow, false);
      for (const target of shape.download) {
        const response = await fetch(origin + target);
        assert.equal(response.status, 200); assert.match(response.headers.get("content-disposition"), /^attachment/);
      }
      if (process.env.ATTACHMENT_SHOTS) {
        await mkdir(process.env.ATTACHMENT_SHOTS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.ATTACHMENT_SHOTS, phone ? "phone-attachments.png" : "desktop-attachments.png") });
      }
    } finally { await closePage(page); }
  });
}
