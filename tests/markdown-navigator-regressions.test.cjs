const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { readFile } = require("node:fs/promises");
const { createServer } = require("node:http");
const path = require("node:path");
const puppeteer = require("puppeteer-core");

const ROOT = path.resolve(__dirname, "..");
const CHROME = process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ROOTS = [
  { kind: "internal", root: "sample-internal", files: [
    { rel: "README.md", name: "README.md", mtime: "1" },
    { rel: "guides/intro.md", name: "intro.md", mtime: "2" },
    { rel: "guides/deep/topic.md", name: "topic.md", mtime: "3" },
    { rel: "notes/today.md", name: "today.md", mtime: "4" },
  ] },
  { kind: "wiki", root: "sample-wiki", files: [
    { rel: "home.md", name: "home.md", mtime: "5" },
    { rel: "reference/api.md", name: "api.md", mtime: "6" },
  ] },
];

let browser;
let server;
let origin;

before(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const files = new Map([
      ["README.md", "# Read me"], ["guides/intro.md", "# Introduction"],
      ["guides/deep/topic.md", "# Topic"], ["notes/today.md", "# Today"],
      ["home.md", "# Home"], ["reference/api.md", "# API"],
    ]);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(await readFile(path.join(ROOT, "index.html")));
    } else if (["/cm-markdown.js", "/card-markdown.js", "/card-logic.js",
      "/card-report.js", "/compose-format.js"].includes(url.pathname)) {
      res.setHeader("content-type", "text/javascript; charset=utf-8");
      res.end(await readFile(path.join(ROOT, url.pathname.slice(1))));
    } else if (url.pathname === "/card-tokens.css") {
      res.setHeader("content-type", "text/css; charset=utf-8");
      res.end(await readFile(path.join(ROOT, "card-tokens.css")));
    } else if (url.pathname === "/mdfile") {
      const rel = url.searchParams.get("rel");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ text: files.get(rel), mtime: "fixture", crlf: false }));
    } else {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true,
    args: ["--disable-background-networking", "--no-first-run"] });
});

after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

async function navigator(lane = "pastureland", width = 340) {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 760, deviceScaleFactor: 2 });
  await page.goto(`${origin}/index.html`, { waitUntil: "domcontentloaded" });
  await page.evaluate(({ selectedLane, roots, panelWidth }) => {
    mdMounts(["website", "pastureland"]);
    activeOwner = selectedLane;
    mdBoxes();
    const host = mdBuild(MD_MOUNTS[selectedLane]);
    host.style.left = "32px";
    host.style.top = "32px";
    host.style.width = panelWidth + "px";
    host.style.height = "500px";
    mdFor = selectedLane;
    mdKind = "internal";
    mdData = { roots };
    mdSig = "";
    mdDrawList();
  }, { selectedLane: lane, roots: ROOTS, panelWidth: width });
  return page;
}

async function rows(page) {
  return page.$$eval(".mdrow", all => all.map(row => ({
    name: row.querySelector(".mdrowname").textContent,
    kind: row.classList.contains("folder") ? "folder" : "file",
    selected: row.classList.contains("selected"),
  })));
}

test("shows only immediate children with folders first", async () => {
  const page = await navigator();
  try {
    assert.deepEqual(await rows(page), [
      { name: "guides/", kind: "folder", selected: false },
      { name: "notes/", kind: "folder", selected: false },
      { name: "README.md", kind: "file", selected: false },
    ]);
    await page.click(".mdrow.folder");
    assert.equal((await rows(page))[0].selected, true);
    assert.equal(await page.$eval(".mdnav", el => el.hidden), true);
    assert.equal(await page.$eval(".mdrow", el => el.querySelector(".mdrowicon")), null);
  } finally { await page.close(); }
});

test("double click and Enter navigate folders, breadcrumbs, and files", async () => {
  const page = await navigator();
  try {
    await page.$eval(".mdrow.folder", row =>
      row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    assert.deepEqual((await rows(page)).map(row => row.name), ["deep/", "intro.md"]);
    assert.equal(await page.$eval(".mdcrumbs", el => el.textContent), "guides");
    await page.focus(".mdrow.file");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#magic4.editing");
    assert.equal(await page.$eval(".mdname", el => el.textContent), "guides/intro.md");
    await page.click(".mdback");
    assert.deepEqual((await rows(page)).map(row => row.name), ["deep/", "intro.md"]);
    await page.click(".mdup");
    assert.deepEqual((await rows(page)).map(row => row.name), ["guides/", "notes/", "README.md"]);
  } finally { await page.close(); }
});

test("keeps directory state separate across lanes and roots", async () => {
  const page = await navigator();
  try {
    await page.$eval(".mdrow.folder", row =>
      row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    await page.click(".mdtab:nth-child(2)");
    assert.deepEqual((await rows(page)).map(row => row.name), ["reference/", "home.md"]);
    await page.$eval(".mdrow.folder", row =>
      row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    await page.click(".mdtab:first-child");
    assert.equal(await page.$eval(".mdcrumbs", el => el.textContent), "guides");
    await page.evaluate(roots => {
      mdOff(); activeOwner = "website"; mdBoxes();
      const host = mdBuild(MD_MOUNTS.website);
      mdFor = "website"; mdKind = "internal"; mdData = { roots }; mdSig = ""; mdDrawList();
    }, ROOTS);
    assert.equal(await page.$eval("#magic3 .mdnav", el => el.hidden), true);
  } finally { await page.close(); }
});

test("poll redraw preserves the selected row and scroll position", async () => {
  const page = await navigator("pastureland", 250);
  try {
    await page.evaluate(() => {
      const root = mdData.roots[0];
      for (let i = 0; i < 30; i++) root.files.push({
        rel: `document-${String(i).padStart(2, "0")}.md`,
        name: `document-${String(i).padStart(2, "0")}.md`, mtime: "1",
      });
      document.querySelector("#magic4").style.height = "180px";
      mdSig = ""; mdDrawList();
    });
    await page.click(".mdrow.file:nth-of-type(15)");
    await page.evaluate(() => {
      const list = document.querySelector("#magic4 .mdlist");
      list.scrollTop = 100;
      mdData.roots[0].files[0].mtime = "new";
      mdDrawList();
    });
    const state = await page.evaluate(() => {
      const list = document.querySelector("#magic4 .mdlist");
      const selected = list.querySelector(".selected");
      return {
        selected: selected && selected.querySelector(".mdrowname").textContent,
        scroll: list.scrollTop,
        overflow: [...list.querySelectorAll(".mdrow")].some(row => row.scrollWidth > row.clientWidth),
        nameOverflow: [...list.querySelectorAll(".mdrowname")].some(name =>
          name.getBoundingClientRect().right > list.getBoundingClientRect().right),
      };
    });
    assert.equal(state.selected, "document-12.md");
    assert.equal(state.scroll, 100);
    assert.equal(state.nameOverflow, false);
  } finally { await page.close(); }
});

test("opening and closing a file restores the live list scroll", async () => {
  const page = await navigator("pastureland", 250);
  try {
    await page.evaluate(() => {
      const root = mdData.roots[0];
      for (let i = 0; i < 30; i++) root.files.push({
        rel: `document-${String(i).padStart(2, "0")}.md`,
        name: `document-${String(i).padStart(2, "0")}.md`, mtime: "1",
      });
      document.querySelector("#magic4").style.height = "180px";
      mdSig = ""; mdDrawList();
      document.querySelector("#magic4 .mdlist").scrollTop = 100;
      document.querySelector("#magic4 .mdrow.file:last-child")
        .dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    await page.waitForSelector("#magic4.editing");
    await page.click(".mdback");
    assert.equal(await page.$eval("#magic4 .mdlist", list => list.scrollTop), 100);
  } finally { await page.close(); }
});

test("deep breadcrumbs keep the current folder and Up control visible", async () => {
  const page = await navigator("pastureland", 250);
  try {
    await page.evaluate(() => {
      mdData.roots[0].files.push({
        rel: "long-ancestor/another-long-ancestor/current-folder/page.md",
        name: "page.md", mtime: "7",
      });
      mdBrowseState().dir = "long-ancestor/another-long-ancestor/current-folder";
      mdSig = ""; mdDrawList();
    });
    const state = await page.evaluate(() => {
      const crumbs = document.querySelector("#magic4 .mdcrumbs");
      const current = crumbs.querySelector(".mdcrumb:last-child");
      const bounds = crumbs.getBoundingClientRect();
      const box = current.getBoundingClientRect();
      return {
        label: current.textContent,
        visible: box.left >= bounds.left && box.right <= bounds.right,
        upDisabled: document.querySelector("#magic4 .mdup").disabled,
      };
    });
    assert.deepEqual(state, { label: "current-folder", visible: true, upDisabled: false });
  } finally { await page.close(); }
});
