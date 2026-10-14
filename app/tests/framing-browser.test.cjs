// A page on another website tries to show the board inside a frame, in a real
// Chrome with a throwaway profile. The board's own port is the guard's and
// refuses a frame outright; the phone's port, which Tailscale Serve publishes,
// is the bridge gate's and serves its sign-in page to anyone, so there the
// answer's own frame header is the only thing that keeps the page out.
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

let board, other, otherOrigin, browser, profile;

const framing = sources => `<!doctype html><meta charset="utf-8"><title>another site</title><body><script>
window.__loaded = 0;
for (const src of ${JSON.stringify(sources)}) {
  const frame = document.createElement("iframe");
  frame.onload = () => { window.__loaded += 1; };
  frame.src = src;
  document.body.append(frame);
}
</script>`;

before(async () => {
  board = await startBoard();
  const port = await freePortPair();
  otherOrigin = `http://localhost:${port}`;
  other = createServer((req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(framing(new URL(req.url, otherOrigin).searchParams.getAll("src")));
  });
  await new Promise(resolve => other.listen(port, "127.0.0.1", resolve));
  profile = await mkdtemp(path.join(tmpdir(), "facilitator-framing-profile-"));
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: profile,
    args: ["--no-first-run", "--no-default-browser-check", "--disable-background-networking"] });
});

after(async () => {
  if (browser) await browser.close();
  if (other) await new Promise(resolve => other.close(resolve));
  if (board) await board.stop();
  if (profile) await rm(profile, { recursive: true, force: true });
});

// what another site's frames hold: a frame the board answered with a page is
// the board shown; a refusal is JSON; a frame the browser blocked sits on an
// error page at another address
async function shownInFrames(sources) {
  const page = await browser.newPage();
  const query = sources.map(src => "src=" + encodeURIComponent(src)).join("&");
  await page.goto(`${otherOrigin}/?${query}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(count => window.__loaded === count, { timeout: 20000 }, sources.length);
  await new Promise(resolve => setTimeout(resolve, 800));
  const inside = page.frames().filter(frame => frame !== page.mainFrame());
  assert.equal(inside.length, sources.length);
  const shown = [];
  for (const frame of inside) {
    const kind = await frame.evaluate(() => document.contentType).catch(() => "unreadable");
    if (frame.url().startsWith("http://127.0.0.1:") && kind !== "application/json")
      shown.push(`${frame.url().slice(0, 60)} ${kind}`);
  }
  await page.close();
  return shown;
}

test("another site cannot frame the board's own port", async () => {
  assert.deepEqual(await shownInFrames([board.origin + "/", board.origin + "/m", board.origin + "/?code=abc&state=xyz"]), []);
});

test("nor the phone's port, which has no guard in front of it", async () => {
  const phone = `http://127.0.0.1:${board.port + 1}`;
  assert.deepEqual(await shownInFrames([phone + "/m", phone + "/m"]), []);
});
