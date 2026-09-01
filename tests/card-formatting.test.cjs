const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { readFile } = require("node:fs/promises");
const { createServer } = require("node:http");
const path = require("node:path");
const puppeteer = require("puppeteer-core");

const ROOT = path.resolve(__dirname, "..");
const CHROME = process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

let browser;
let server;
let origin;

before(async () => {
  server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, "http://127.0.0.1").pathname;
      const files = {
        "/": "index.html",
        "/index.html": "index.html",
        "/page.html": "page.html",
        "/cm-markdown.js": "cm-markdown.js",
      };
      const file = files[pathname];
      if (!file) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      res.setHeader("content-type", file.endsWith(".js")
        ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8");
      res.end(await readFile(path.join(ROOT, file)));
    } catch (error) {
      res.statusCode = 500;
      res.end(String(error));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--disable-background-networking", "--no-first-run"],
  });
});

after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

for (const pageName of ["index.html", "page.html"]) {
  test(`${pageName} renders protected inline code spans`, async () => {
    const page = await browser.newPage();
    try {
      const suffix = pageName === "page.html" ? "?mock=1" : "";
      await page.goto(`${origin}/${pageName}${suffix}`, { waitUntil: "domcontentloaded" });
      const result = await page.evaluate(() => {
        const source = "Use `<tag> **bold** https://example.com /uploads/x.png` " +
          "and **outside** https://openai.com plus ``double``.";
        const host = document.createElement("div");
        host.className = "reply";
        host.innerHTML = fmt(source);
        document.body.appendChild(host);
        const codes = [...host.querySelectorAll("code.inlinecode")];
        const style = codes[0] && getComputedStyle(codes[0]);

        const unmatched = document.createElement("div");
        unmatched.innerHTML = fmt("Keep `literal");
        const fenced = document.createElement("div");
        fenced.innerHTML = fmt("```\n`literal`\n```");

        return {
          codeTexts: codes.map(code => code.textContent),
          codeChildren: codes.map(code => code.childElementCount),
          links: [...host.querySelectorAll("a")].map(link => link.textContent),
          bold: [...host.querySelectorAll("b")].map(node => node.textContent),
          images: host.querySelectorAll("img").length,
          paddingLeft: style && style.paddingLeft,
          whiteSpace: style && style.whiteSpace,
          unmatchedText: unmatched.textContent,
          unmatchedCodes: unmatched.querySelectorAll("code").length,
          fencedText: fenced.querySelector("pre code")?.textContent,
          fencedInlineCodes: fenced.querySelectorAll("code.inlinecode").length,
        };
      });

      assert.deepEqual(result.codeTexts, [
        "<tag> **bold** https://example.com /uploads/x.png",
        "double",
      ]);
      assert.deepEqual(result.codeChildren, [0, 0], "code content became active markup");
      assert.deepEqual(result.links, ["https://openai.com"], "code URL was linkified");
      assert.deepEqual(result.bold, ["outside"], "code markdown was formatted");
      assert.equal(result.images, 0, "code upload path became an image");
      assert.ok(parseFloat(result.paddingLeft) >= 4, "inline code chip has no padding");
      assert.equal(result.whiteSpace, "pre-wrap", "inline code spacing is not preserved");
      assert.equal(result.unmatchedText, "Keep `literal");
      assert.equal(result.unmatchedCodes, 0, "an unmatched tick became code");
      assert.equal(result.fencedText, "`literal`", "inline parsing changed fenced code");
      assert.equal(result.fencedInlineCodes, 0, "fenced code was nested as inline code");
    } finally {
      await page.close();
    }
  });
}
