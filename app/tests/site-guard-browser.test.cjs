// The same refusal, seen from a real Chrome with a throwaway profile: a page
// served from another site tries to make the board do things, a name pointed
// at this Mac tries to be the board, and the board's own page, and the way
// Spotify's sign-in comes back to it, still work. The other site is a second
// local server reached as localhost, which Chrome counts as a different site
// from 127.0.0.1.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { createServer } = require("node:http");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const puppeteer = require("puppeteer-core");
const { freePortPair } = require("./fixture-auth.cjs");
const { startBoard } = require("./board-fixture.cjs");

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

let board, other, otherPort, otherOrigin, browser, profile;

const attackPage = origin => `<!doctype html><meta charset="utf-8"><title>another site</title><script>
const board = ${JSON.stringify(origin)};
const tries = [
  () => fetch(board + "/send?box=0", { method: "POST", mode: "no-cors", body: "attack-phrase-one" }),
  () => fetch(board + "/send?box=0", { method: "POST", headers: { "Content-Type": "application/json" }, body: "attack-phrase-two" }),
  () => fetch(board + "/create?owner=facilitator", { method: "POST", mode: "no-cors", body: "attack-card" }),
  () => new Promise(done => { const img = new Image(); img.onload = img.onerror = done; img.src = board + "/state?attack=1"; }),
  () => new Promise(done => { const s = document.createElement("script"); s.onload = s.onerror = done;
    s.src = board + "/limits?attack=1"; document.head.append(s); }),
  () => new Promise(done => {
    const frame = document.createElement("iframe"); frame.name = "sink"; document.body.append(frame);
    const form = document.createElement("form"); form.method = "POST"; form.target = "sink";
    form.action = board + "/send?box=0"; const field = document.createElement("textarea");
    field.name = "attack-phrase-three"; field.value = "attack-phrase-three"; form.append(field);
    document.body.append(form); frame.onload = done; form.submit(); setTimeout(done, 1500);
  }),
];
(async () => {
  for (const attempt of tries) { try { await attempt(); } catch (error) {} }
  window.__tried = tries.length;
})();
</script>`;

before(async () => {
  board = await startBoard();
  otherPort = await freePortPair();
  otherOrigin = `http://localhost:${otherPort}`;
  other = createServer((req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (req.url === "/hop") res.end(`<script>location.href = ${JSON.stringify(board.origin + "/?code=abc&state=xyz")};</script>`);
    else res.end(attackPage(board.origin));
  });
  await new Promise(resolve => other.listen(otherPort, "127.0.0.1", resolve));
  profile = await mkdtemp(path.join(tmpdir(), "facilitator-site-guard-profile-"));
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: profile,
    args: ["--no-first-run", "--no-default-browser-check", "--disable-background-networking",
      "--host-resolver-rules=MAP evil.test 127.0.0.1"] });
});

after(async () => {
  if (browser) await browser.close();
  if (other) await new Promise(resolve => other.close(resolve));
  if (board) await board.stop();
  if (profile) await rm(profile, { recursive: true, force: true });
});

// keep the page off the real network (fonts), and report every header the
// browser really put on each request
async function watch(page) {
  await page.setRequestInterception(true);
  page.on("request", request => {
    const host = new URL(request.url()).hostname;
    if (["127.0.0.1", "localhost", "evil.test"].includes(host) || /^(data|blob):/.test(request.url())) request.continue();
    else request.abort();
  });
  const urls = new Map();
  const headers = new Map();
  const client = await page.createCDPSession();
  await client.send("Network.enable");
  client.on("Network.requestWillBeSent", event => urls.set(event.requestId, event.request.url));
  client.on("Network.requestWillBeSentExtraInfo", event => headers.set(event.requestId,
    Object.fromEntries(Object.entries(event.headers).map(([k, v]) => [k.toLowerCase(), v]))));
  return {
    sent(prefix) {
      return [...urls].filter(([, url]) => url.startsWith(prefix)).map(([id]) => headers.get(id)).filter(Boolean);
    },
  };
}

async function thread() {
  return (await (await fetch(board.origin + "/thread?box=0")).text());
}

test("a page from another website cannot make the board do anything", async () => {
  const earlier = JSON.parse(await (await fetch(board.origin + "/state")).text());
  const page = await browser.newPage();
  const seen = await watch(page);
  await page.goto(otherOrigin + "/attack", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__tried !== undefined, { timeout: 20000 });
  await new Promise(resolve => setTimeout(resolve, 400));
  const posts = seen.sent(board.origin + "/send");
  assert.ok(posts.length >= 1, "the browser did send the other site's requests");
  assert.ok(posts.every(h => h["sec-fetch-site"] === "cross-site"), "Chrome marks them as another site's");
  await page.close();

  const text = await thread();
  for (const phrase of ["attack-phrase-one", "attack-phrase-two", "attack-phrase-three"])
    assert.ok(!text.includes(phrase), `${phrase} reached the card`);
  const later = JSON.parse(await (await fetch(board.origin + "/state")).text());
  assert.ok(!JSON.stringify(later).includes("attack-card"), "the other site made a card");
  assert.equal(later.rev, earlier.rev, "the board's revision moved");
});

test("the board's own page in the same browser still loads, reads and writes", async () => {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const seen = await watch(page);
  await page.goto(board.origin + "/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof lastState !== "undefined" && lastState !== null, { timeout: 20000 });
  const status = await page.evaluate(async () =>
    (await fetch("/send?box=0", { method: "POST", body: "typed on the board itself" })).status);
  assert.equal(status, 200);
  assert.match(await thread(), /typed on the board itself/);
  const own = seen.sent(board.origin + "/state");
  assert.ok(own.length >= 1 && own.every(h => h["sec-fetch-site"] === "same-origin"));
  assert.deepEqual(errors, []);
  await page.close();
});

async function opensFromHop(page) {
  await page.goto(otherOrigin + "/hop", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(origin => location.origin === origin && typeof lastState !== "undefined"
    && lastState !== null, { timeout: 20000 }, board.origin);
}

test("the Spotify return, a top-level navigation from another site, still opens the board's page", async () => {
  // a fresh profile context, so no service worker of the board's stands between
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const seen = await watch(page);
  await opensFromHop(page);
  const arrival = seen.sent(board.origin + "/?code=abc");
  assert.ok(arrival.length >= 1);
  assert.equal(arrival[0]["sec-fetch-site"], "cross-site", "it arrives as another site's link");
  assert.equal(arrival[0]["sec-fetch-mode"], "navigate");
  assert.equal(arrival[0]["sec-fetch-dest"], "document");
  await context.close();
});

test("the same return opens the page when the board's own service worker is installed, as it is in the app window", async () => {
  const page = await browser.newPage();
  await page.goto(board.origin + "/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistrations()).some(r => r.active),
    { timeout: 20000 });
  await page.close();
  const returning = await browser.newPage();
  await watch(returning);
  await opensFromHop(returning);
  await returning.close();
});

test("a name pointed at this Mac is not the board: its page is not served under it", async () => {
  const page = await browser.newPage();
  const response = await page.goto(`http://evil.test:${board.port}/`, { waitUntil: "domcontentloaded" });
  assert.equal(response.status(), 403);
  assert.equal(await page.evaluate(() => typeof lastState), "undefined");
  const api = await page.goto(`http://evil.test:${board.port}/state`, { waitUntil: "domcontentloaded" });
  assert.equal(api.status(), 403);
  await page.close();
});
