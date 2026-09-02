const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createServer } = require("node:http");
const { copyFile, mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const puppeteer = require("puppeteer-core");

const ROOT = path.resolve(__dirname, "..");
const CHROME = process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

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

async function api(route, options = {}) {
  const response = await fetch(origin + route, options);
  return { status: response.status, body: await response.json() };
}

async function create(title) {
  const result = await api("/create?owner=facilitator", { method: "POST", body: title });
  assert.equal(result.status, 200);
  return result.body.id;
}

async function savedBox(id) {
  const result = await api("/state");
  assert.equal(result.status, 200);
  return result.body.boxes.find(box => box.id === id);
}

async function transcriptFor(id) {
  const raw = await readFile(path.join(fixtureDir, "transcript.jsonl"), "utf8");
  return raw.trim().split("\n").filter(Boolean).map(JSON.parse).filter(event => event.box === id);
}

async function openBoard(route) {
  const page = await browser.newPage();
  await page.goto(origin + route, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() =>
    ownerReady && activeOwner === "facilitator" && lastState !== null,
  { timeout: 5000 });
  return page;
}

async function addEmptyBirth(page, title) {
  const id = await create(title);
  await page.evaluate(() => poll());
  await page.waitForFunction(cardId => {
    const box = lastState?.boxes.find(item => item.id === cardId);
    return !!document.getElementById(`box-${cardId}`) && box &&
      box.reply === "" && box.replies === 0 && box.pending === 0;
  }, { timeout: 5000 }, id);
  return id;
}

async function postFreshReply(id, text) {
  const result = await api(`/reply?box=${id}`, { method: "POST", body: text });
  assert.equal(result.status, 200);
}

async function expectDoneOnly(id) {
  const saved = await savedBox(id);
  assert.ok(saved, "the browser close deleted the card");
  assert.equal(saved.done, true);
  assert.equal(saved.parked, false);
  const kinds = (await transcriptFor(id)).map(event => event.kind);
  assert.ok(kinds.includes("done"), "the browser close did not log done");
  assert.equal(kinds.includes("delete"), false, "the browser close logged delete");
}

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-done-close-browser-"));
  const port = await freePort();
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "test server port was not patched");
  await writeFile(path.join(fixtureDir, "server.py"), patched);
  await copyFile(path.join(ROOT, "index.html"), path.join(fixtureDir, "index.html"));
  await copyFile(path.join(ROOT, "page.html"), path.join(fixtureDir, "page.html"));
  await copyFile(path.join(ROOT, "card-markdown.js"), path.join(fixtureDir, "card-markdown.js"));
  await copyFile(path.join(ROOT, "card-tokens.css"), path.join(fixtureDir, "card-tokens.css"));
  await copyFile(path.join(ROOT, "card-logic.js"), path.join(fixtureDir, "card-logic.js"));
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({
    title: "browser authoritative close test", items: [],
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
    await new Promise(resolve => setTimeout(resolve, 25));
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

for (const fixture of [
  { name: "index main", route: "/", selector: id => `#box-${id} .xbtn` },
  { name: "page main", route: "/page", selector: id => `#box-${id} .xbtn` },
]) {
  test(`${fixture.name} closes a freshly replied card without rebuilding its empty birth node`, async () => {
    const page = await openBoard(fixture.route);
    try {
      const id = await addEmptyBirth(page, `${fixture.name} stale birth`);
      const token = `${fixture.name}-${id}`;
      await page.evaluate(({ id: cardId, marker }) => {
        select(cardId);
        document.querySelector(`#box-${cardId} .xbtn`).dataset.birthMarker = marker;
      }, { id, marker: token });

      await postFreshReply(id, `Fresh reply for ${fixture.name}`);
      await page.evaluate(() => poll());
      const reconciled = await page.evaluate(({ id: cardId, marker }) => ({
        sameNode: document.querySelector(`#box-${cardId} .xbtn`)?.dataset.birthMarker === marker,
        reply: lastState.boxes.find(item => item.id === cardId)?.reply,
        shown: els[cardId]?.reply?.dataset.raw,
      }), { id, marker: token });
      assert.equal(reconciled.sameNode, true, "poll rebuilt the card instead of exercising the stale handler");
      assert.equal(reconciled.reply, `Fresh reply for ${fixture.name}`);
      assert.equal(reconciled.shown, `Fresh reply for ${fixture.name}`);

      const response = page.waitForResponse(candidate => {
        const url = new URL(candidate.url());
        return url.pathname === "/close" && url.searchParams.get("box") === id;
      });
      await page.evaluate(selector => document.querySelector(selector).click(), fixture.selector(id));
      assert.equal((await response).status(), 200);
      await expectDoneOnly(id);
    } finally {
      await page.close();
    }
  });
}

test("index mini closes a freshly replied card without rebuilding its empty birth node", async () => {
  const page = await openBoard("/");
  try {
    const id = await addEmptyBirth(page, "index mini stale birth");
    const token = `index-mini-${id}`;
    const bornEmpty = await page.evaluate(({ id: cardId, marker }) => {
      miniGo(cardId);
      renderMiniCards(lastState);
      const el = miniEls[cardId];
      el.box.dataset.birthMarker = marker;
      return {
        reply: lastState.boxes.find(item => item.id === cardId)?.reply,
        replies: lastState.boxes.find(item => item.id === cardId)?.replies,
      };
    }, { id, marker: token });
    assert.deepEqual(bornEmpty, { reply: "", replies: 0 });

    await postFreshReply(id, "Fresh reply for index mini");
    await page.evaluate(() => poll());
    const reconciled = await page.evaluate(({ id: cardId, marker }) => ({
      sameNode: miniEls[cardId]?.box?.dataset.birthMarker === marker,
      reply: lastState.boxes.find(item => item.id === cardId)?.reply,
      shown: miniEls[cardId]?.reply?.dataset.raw,
    }), { id, marker: token });
    assert.equal(reconciled.sameNode, true, "poll rebuilt the mini card");
    assert.equal(reconciled.reply, "Fresh reply for index mini");
    assert.equal(reconciled.shown, "Fresh reply for index mini");

    const response = page.waitForResponse(candidate => {
      const url = new URL(candidate.url());
      return url.pathname === "/close" && url.searchParams.get("box") === id;
    });
    await page.evaluate(cardId => miniEls[cardId].box.querySelector(".mx").click(), id);
    assert.equal((await response).status(), 200);
    await expectDoneOnly(id);
  } finally {
    await page.close();
  }
});

test("index Delete key uses the authoritative close endpoint", async () => {
  const page = await openBoard("/");
  try {
    const id = await addEmptyBirth(page, "index keyboard close");
    await postFreshReply(id, "Fresh reply for index keyboard");
    await page.evaluate(() => poll());
    await page.evaluate(cardId => {
      select(cardId);
      document.activeElement?.blur();
    }, id);

    const response = page.waitForResponse(candidate => {
      const url = new URL(candidate.url());
      return url.pathname === "/close" && url.searchParams.get("box") === id;
    });
    await page.keyboard.press("Delete");
    assert.equal((await response).status(), 200);
    await expectDoneOnly(id);
  } finally {
    await page.close();
  }
});

test("page Delete key remains inert in document view", async () => {
  const page = await openBoard("/page");
  try {
    const id = await addEmptyBirth(page, "page keyboard stays inert");
    await postFreshReply(id, "Fresh reply for inert page keyboard");
    await page.evaluate(() => poll());
    await page.evaluate(cardId => {
      select(cardId);
      document.activeElement?.blur();
    }, id);
    const closeRequests = [];
    page.on("request", request => {
      if (new URL(request.url()).pathname === "/close") closeRequests.push(request.url());
    });

    await page.keyboard.press("Delete");
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(closeRequests, [], "document view enabled its deliberately disabled close key");
    const saved = await savedBox(id);
    assert.ok(saved);
    assert.equal(saved.done, false);
    const kinds = (await transcriptFor(id)).map(event => event.kind);
    assert.equal(kinds.includes("done"), false);
    assert.equal(kinds.includes("delete"), false);
  } finally {
    await page.close();
  }
});
