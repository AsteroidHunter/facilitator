// Browser regressions for the general file navigator (the former Markdown-only
// panel). The fixture serves the reshaped, bounded per-directory listing that
// /mdfiles now answers, plus /mdfile and /mdimg, from a synthetic tree, so the
// page's real mdList/mdDrawList/open paths are exercised end to end.
//
// NOTE ON EXECUTION: this suite launches headed Chrome through puppeteer. Under
// the standing background-only browser policy (browser-testing-policy) automated
// browser actions were paused mid-task, so this file was UPDATED to the new
// contract but NOT executed by the implementing worker. Root runs it during
// integration on the owned background browser.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { readFile } = require("node:fs/promises");
const { createServer } = require("node:http");
const path = require("node:path");
const puppeteer = require("puppeteer-core");

const ROOT = path.resolve(__dirname, "..");
const CHROME = process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// a synthetic tree per root. a plain object is a folder; a node with `text` is a
// text file, `binary` an unopenable file, `image` an image. Every lane name and
// file name here is invented.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64");
const TREE = {
  "sample-internal": {
    "README.md": { text: "# Read me" },
    guides: {
      "intro.md": { text: "# Introduction" },
      deep: { "topic.md": { text: "# Topic" } },
    },
    notes: { "today.md": { text: "# Today" } },
    "diagram.png": { image: PNG },
    "archive.bin": { binary: Buffer.from([0, 1, 2, 3, 4, 5]) },
    "script.py": { text: "print('hi')\n" },
  },
  "sample-wiki": {
    "home.md": { text: "# Home" },
    reference: { "api.md": { text: "# API" } },
  },
};
const ROOTS_META = [
  { root: "sample-internal", kind: "internal", exists: true },
  { root: "sample-wiki", kind: "wiki", exists: true },
];

function walk(root, rel) {
  let node = TREE[root];
  if (!node) return null;
  if (rel) for (const part of rel.split("/")) {
    if (!node || typeof node !== "object" || !(part in node)) return null;
    node = node[part];
    if (node.text || node.binary || node.image) return null; // a file, not a dir
  }
  return node;
}
function nodeType(n) { return (n && (n.text || n.binary || n.image)) ? "file" : "dir"; }
function fileBytes(n) { return n.image || n.binary || Buffer.from(n.text || "", "utf8"); }
function listing(kind, rel) {
  const rootName = "sample-" + kind;
  const dir = walk(rootName, rel);
  const out = { roots: ROOTS_META, kind, root: rootName, dir: rel, exists: !!dir, entries: [] };
  if (!dir) return out;
  const entries = Object.keys(dir).map(name => {
    const n = dir[name];
    const type = nodeType(n);
    const e = { name, type, avail: true };
    if (type === "file") {
      e.ext = (name.split(".").pop() || "").toLowerCase();
      e.size = fileBytes(n).length;
      e.mtime = String((TREE.__mt = (TREE.__mt || 1000) + 1) * 1e6);
    }
    return e;
  });
  entries.sort((a, b) => (a.type !== "dir") - (b.type !== "dir") ||
    a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  out.entries = entries;
  return out;
}

let browser, server, origin;

before(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const send = (obj) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(obj)); };
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
    } else if (url.pathname === "/mdfiles") {
      send(listing(url.searchParams.get("kind") || "internal", url.searchParams.get("rel") || ""));
    } else if (url.pathname === "/mdfile") {
      const kind = url.searchParams.get("root") === "sample-wiki" ? "wiki" : "internal";
      const node = (function () {
        let n = TREE["sample-" + kind];
        for (const part of (url.searchParams.get("rel") || "").split("/")) n = n && n[part];
        return n;
      })();
      if (!node || node.image) { res.statusCode = 404; return send({ error: "no such file" }); }
      if (node.binary) { res.statusCode = 415; return send({ error: "not a text file" }); }
      send({ text: node.text, mtime: "fixture", crlf: false });
    } else if (url.pathname === "/mdimg") {
      res.setHeader("content-type", "image/png");
      res.setHeader("content-security-policy", "sandbox");
      res.setHeader("x-content-type-options", "nosniff");
      res.end(PNG);
    } else {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
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
  await page.evaluate(async ({ selectedLane, panelWidth }) => {
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
    mdData = null; mdSig = "";
    await mdList();
  }, { selectedLane: lane, panelWidth: width });
  await page.waitForSelector(".mdrow");
  return page;
}

async function rows(page) {
  return page.$$eval(".mdrow", all => all.map(row => ({
    name: row.querySelector(".mdrowname").textContent,
    kind: row.classList.contains("folder") ? "folder" : "file",
    icon: !!row.querySelector(".mdrowicon svg"),
    selected: row.classList.contains("selected"),
  })));
}

test("lists every in-root name with a type icon, folders first", async () => {
  const page = await navigator();
  try {
    const r = await rows(page);
    assert.deepEqual(r.map(x => x.name),
      ["guides/", "notes/", "archive.bin", "diagram.png", "README.md", "script.py"]);
    // every row now carries an inline icon (the old no-icon expectation is gone)
    assert.ok(r.every(x => x.icon), "each row should render an SVG type icon");
    assert.equal(r[0].kind, "folder");
  } finally { await page.close(); }
});

test("folder and file labels are plain black, not orange or grey", async () => {
  const page = await navigator();
  try {
    const colors = await page.$$eval(".mdrow .mdrowname", els =>
      els.map(el => getComputedStyle(el).color));
    // --ink resolves to a near-black; assert none are the old orange/grey
    for (const c of colors) {
      const [r, g, b] = c.match(/\d+/g).map(Number);
      assert.ok(r < 60 && g < 60 && b < 60, "label should be black, got " + c);
    }
  } finally { await page.close(); }
});

test("double click and Enter navigate folders, breadcrumbs, and files", async () => {
  const page = await navigator();
  try {
    await page.$eval(".mdrow.folder", row =>
      row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    await page.waitForFunction(() => document.querySelector(".mdcrumbs") &&
      document.querySelector(".mdcrumbs").textContent === "guides");
    assert.deepEqual((await rows(page)).map(row => row.name), ["deep/", "intro.md"]);
    await page.focus(".mdrow.file");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#magic4.editing");
    assert.equal(await page.$eval(".mdname", el => el.textContent), "guides/intro.md");
    await page.click(".mdback");
    await page.waitForSelector(".mdrow");
    assert.deepEqual((await rows(page)).map(row => row.name), ["deep/", "intro.md"]);
    await page.click(".mdup");
    await page.waitForFunction(() =>
      [...document.querySelectorAll(".mdrowname")].some(n => n.textContent === "README.md"));
  } finally { await page.close(); }
});

test("an image opens in the preview, not the editor", async () => {
  const page = await navigator();
  try {
    await page.$$eval(".mdrow.file", (els) => {
      const img = els.find(e => e.querySelector(".mdrowname").textContent === "diagram.png");
      img.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    await page.waitForSelector("#magic4.previewing");
    const src = await page.$eval(".mdimg", el => el.getAttribute("src"));
    assert.ok(src.startsWith("/mdimg?"), "image should be served from /mdimg");
    assert.equal(await page.$("#magic4 .cm-editor"), null, "no editor for an image");
    await page.click(".mdback");
    await page.waitForSelector(".mdrow");
  } finally { await page.close(); }
});

test("a non-text file shows a not-editable info card", async () => {
  const page = await navigator();
  try {
    await page.$$eval(".mdrow.file", (els) => {
      const bin = els.find(e => e.querySelector(".mdrowname").textContent === "archive.bin");
      bin.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    await page.waitForSelector("#magic4.unopenable");
    const why = await page.$eval(".mdunopenwhy", el => el.textContent);
    assert.match(why, /not a text file/i);
    assert.equal(await page.$("#magic4 .cm-editor"), null);
  } finally { await page.close(); }
});

test("keeps directory state separate across roots", async () => {
  const page = await navigator();
  try {
    await page.$eval(".mdrow.folder", row =>
      row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    await page.waitForFunction(() => document.querySelector(".mdcrumbs").textContent === "guides");
    await page.click(".mdtab:nth-child(2)");   // wiki
    await page.waitForFunction(() =>
      [...document.querySelectorAll(".mdrowname")].some(n => n.textContent === "home.md"));
    assert.deepEqual((await rows(page)).map(row => row.name), ["reference/", "home.md"]);
    await page.click(".mdtab:first-child");    // back to internal, still in guides
    await page.waitForFunction(() => document.querySelector(".mdcrumbs").textContent === "guides");
  } finally { await page.close(); }
});
