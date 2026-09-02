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
        "/card-markdown.js": "card-markdown.js",
        "/card-tokens.css": "card-tokens.css",
        "/card-logic.js": "card-logic.js",
      };
      const file = files[pathname];
      if (!file) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      res.setHeader("content-type", file.endsWith(".js") ? "text/javascript; charset=utf-8"
        : file.endsWith(".css") ? "text/css; charset=utf-8" : "text/html; charset=utf-8");
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
        document.body.classList.add("focus");
        const box = document.createElement("div");
        box.className = "box sel";
        const host = document.createElement("div");
        host.className = "reply";
        host.innerHTML = fmt(source);
        box.appendChild(host);
        document.body.appendChild(box);
        const codes = [...host.querySelectorAll("code.inlinecode")];
        const style = codes[0] && getComputedStyle(codes[0]);

        const unmatched = document.createElement("div");
        unmatched.innerHTML = fmt("Keep `literal");
        const fenced = document.createElement("div");
        fenced.innerHTML = fmt("```\n`literal`\n```");

        return {
          codeTexts: codes.map(code => code.textContent),
          codeChildren: codes.map(code => code.childElementCount),
          codeFontSize: style && style.fontSize,
          hostFontSize: getComputedStyle(host).fontSize,
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
      assert.equal(result.hostFontSize, pageName === "index.html" ? "18px" : "17px",
        "test fixture did not use focused card typography");
      assert.equal(result.codeFontSize, result.hostFontSize,
        "inline code font size differs from its card text");
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

  test(`${pageName} renders the full card subset without creating active attributes`, async () => {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(String(error)));
    try {
      const suffix = pageName === "page.html" ? "?mock=1" : "";
      await page.goto(`${origin}/${pageName}${suffix}`, { waitUntil: "domcontentloaded" });
      const result = await page.evaluate(async () => {
        globalThis.__cardPwned = 0;
        const source = [
          "# Heading *one*",
          "",
          "~~gone~~ [named](https://example.com/docs) (https://example.com/a_(b)).",
          "",
          "![local](/uploads/local.png) ![remote](https://remote.invalid/no-fetch.png)",
          "",
          "| Name | Count |",
          "| :--- | ---: |",
          "| **A** | 2 |",
          "",
          "    indented <code>",
          "",
          "- parent",
          "  continued",
          "  + nested",
          "* sibling",
          "",
          "> quote",
          "```js\" onmouseover=\"globalThis.__cardPwned=7",
          "const value = '<tag>';",
          "```",
          "- after fence",
          "",
          "---",
          "",
          "https://safe.invalid/x\" onmouseover=\"globalThis.__cardPwned=1",
          "[hostile](https://safe.invalid/x\" onclick=\"globalThis.__cardPwned=2)",
          "/uploads/bare.png\" onerror=\"globalThis.__cardPwned=3",
          "![hostile](/uploads/markdown.png\" onload=\"globalThis.__cardPwned=4)",
        ].join("\n");
        const host = document.createElement("div");
        host.className = "reply cardmd";
        host.innerHTML = fmt(source);
        host.addEventListener("click", event => event.preventDefault(), true);
        document.body.appendChild(host);
        for (const node of host.querySelectorAll("a, img, .codeblockwrap")) {
          for (const type of ["error", "load", "click", "mouseover", "focus"])
            node.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
        }
        await new Promise(resolve => setTimeout(resolve, 150));
        const activeAttributes = [...host.querySelectorAll("*")].flatMap(node =>
          [...node.attributes].filter(attr => /^on/i.test(attr.name))
            .map(attr => `${node.tagName}.${attr.name}`));
        const language = host.querySelector(".codeblockwrap[data-language]");
        return {
          pwned: globalThis.__cardPwned,
          activeAttributes,
          scripts: host.querySelectorAll("script").length,
          links: [...host.querySelectorAll("a")].map(node => ({
            text: node.textContent, href: node.getAttribute("href"), rel: node.rel,
          })),
          images: [...host.querySelectorAll("img.shot")].map(node => node.getAttribute("src")),
          remoteTextVisible: host.textContent.includes("![remote](https://remote.invalid/no-fetch.png)"),
          headings: host.querySelectorAll("h1").length,
          emphasis: host.querySelectorAll("em").length,
          strikes: host.querySelectorAll("del").length,
          tables: host.querySelectorAll("table").length,
          nestedLists: host.querySelectorAll("li ul").length,
          indentedCode: [...host.querySelectorAll("pre code")].some(node =>
            node.textContent.includes("indented <code>")),
          fenceCode: [...host.querySelectorAll("pre code")].some(node =>
            node.textContent.includes("const value = '<tag>';")),
          quotes: host.querySelectorAll("blockquote").length,
          rules: host.querySelectorAll("hr").length,
          languageText: host.querySelector(".codelang")?.textContent,
          languageData: language?.getAttribute("data-language"),
        };
      });

      assert.equal(result.pwned, 0, "an injected handler executed");
      assert.deepEqual(result.activeAttributes, [], "an event-handler attribute was created");
      assert.equal(result.scripts, 0);
      assert.equal(result.links.length, 4);
      assert.equal(result.links[0].text, "named");
      assert.equal(result.links[1].text, "https://example.com/a_(b)");
      assert.ok(result.links.every(link => link.rel === "noopener"));
      assert.equal(result.images.length, 3, "remote Markdown image became a fetchable image");
      assert.ok(result.images.every(src => src.startsWith("/uploads/")));
      assert.equal(result.remoteTextVisible, true);
      assert.equal(result.headings, 1);
      assert.ok(result.emphasis >= 1);
      assert.equal(result.strikes, 1);
      assert.equal(result.tables, 1);
      assert.equal(result.nestedLists, 1);
      assert.equal(result.indentedCode, true);
      assert.equal(result.fenceCode, true);
      assert.equal(result.quotes, 1);
      assert.equal(result.rules, 1);
      assert.equal(result.languageText, 'js" onmouseover="globalThis.__cardPwned=7');
      assert.equal(result.languageData, 'js" onmouseover="globalThis.__cardPwned=7');
      assert.deepEqual(errors, [], "page raised an uncaught error");
    } finally {
      await page.close();
    }
  });
}

test("index main and mini card prose have real DOM and style parity", async () => {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  try {
    await page.goto(`${origin}/index.html`, { waitUntil: "domcontentloaded" });
    const result = await page.evaluate(() => {
      const source = [
        "# Heading", "", "[link](https://example.com) and `code`", "",
        "![image](/uploads/style.png)", "", "> quote", "", "- list", "",
        "```js", "code", "```", "", "| A | B |", "| --- | --- |", "| x | y |", "", "---",
      ].join("\n");
      const main = document.createElement("div");
      main.className = "reply cardmd";
      main.innerHTML = fmt(source);
      document.body.appendChild(main);
      const miniRoot = document.getElementById("magic2");
      renderMiniCards({ boxes: [{
        id: "format-proof", owner: "facilitator", title: "proof",
        done: false, parked: false, replies: 1, reply: "legacy fallback must not render",
        replyFull: source, replyShort: source,
        pending: 1, pendingTexts: [source], pendingStamps: [0],
      }] });
      const mini = miniRoot.querySelector(".mreply");
      const miniPending = miniRoot.querySelector(".mpending-message");
      miniPending.closest(".mpend").classList.add("open");

      const selectors = ["a", ".inlinecode", ".codeblock", ".shot", "blockquote",
        "ul", "h1", ".tablewrap", "table", "td", "hr"];
      const props = {
        a: ["textDecorationLine", "textUnderlineOffset"],
        ".inlinecode": ["backgroundColor", "paddingLeft", "whiteSpace", "fontFamily"],
        ".codeblock": ["backgroundColor", "overflowX", "whiteSpace", "borderRadius"],
        ".shot": ["display", "maxWidth", "borderRadius"],
        blockquote: ["borderLeftWidth", "borderLeftStyle", "paddingLeft"],
        ul: ["paddingLeft", "listStyleType"],
        h1: ["fontFamily", "fontWeight"],
        ".tablewrap": ["overflowX", "maxWidth"],
        table: ["borderCollapse"],
        td: ["borderTopWidth", "borderTopStyle", "paddingLeft"],
        hr: ["borderTopWidth", "borderTopStyle", "marginTop"],
      };
      const styles = host => Object.fromEntries(selectors.map(selector => {
        const node = host.querySelector(selector);
        const style = getComputedStyle(node);
        return [selector, Object.fromEntries(props[selector].map(prop => [prop, style[prop]]))];
      }));
      return {
        sameMarkup: main.innerHTML === mini.innerHTML,
        samePendingMarkup: main.innerHTML === miniPending.innerHTML,
        main: styles(main),
        mini: styles(mini),
        miniPending: styles(miniPending),
        mainTags: selectors.every(selector => !!main.querySelector(selector)),
        miniTags: selectors.every(selector => !!mini.querySelector(selector)),
        miniPendingTags: selectors.every(selector => !!miniPending.querySelector(selector)),
      };
    });
    assert.equal(result.sameMarkup, true);
    assert.equal(result.samePendingMarkup, true);
    assert.equal(result.mainTags, true);
    assert.equal(result.miniTags, true);
    assert.equal(result.miniPendingTags, true);
    assert.deepEqual(result.mini, result.main);
    assert.deepEqual(result.miniPending, result.main);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

for (const pageName of ["index.html", "page.html"]) {
  test(`${pageName} quick-chat call site uses shared safe Markdown`, async () => {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(String(error)));
    try {
      const suffix = pageName === "page.html" ? "?mock=1" : "";
      await page.goto(`${origin}/${pageName}${suffix}`, { waitUntil: "domcontentloaded" });
      const result = await page.evaluate(async () => {
        globalThis.__quickPwned = 0;
        const rich = [
          "# Thread heading", "", "[named](https://example.com) and `code`", "",
          "![local](/uploads/thread.png)",
          "![remote](https://remote.invalid/thread.png)", "", "- list", "", "---", "",
          '[hostile](https://safe.invalid/x" onclick="globalThis.__quickPwned=1)',
        ].join("\n");
        const nativeFetch = globalThis.fetch;
        globalThis.fetch = async (input, options) => {
          if (String(input).startsWith("/thread?box=q")) {
            return { json: async () => ({ messages: [
              { kind: "agent", ts: 100, text: "legacy fallback", replyFull: rich },
              { kind: "user", ts: 101, text: "*user emphasis*" },
            ] }) };
          }
          return nativeFetch(input, options);
        };
        qSig = "";
        await pollQ();
        globalThis.fetch = nativeFetch;
        const bubbles = [...document.querySelectorAll("#qmsgs .qb")];
        for (const node of document.querySelectorAll("#qmsgs a, #qmsgs img")) {
          for (const type of ["click", "load", "error", "mouseover"])
            node.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
        }
        const activeAttributes = [...document.querySelectorAll("#qmsgs *")].flatMap(node =>
          [...node.attributes].filter(attribute => /^on/i.test(attribute.name))
            .map(attribute => attribute.name));
        return {
          bubbleCount: bubbles.length,
          cardmdCount: document.querySelectorAll("#qmsgs .qb.cardmd").length,
          heading: bubbles[0].querySelector("h1")?.textContent,
          link: bubbles[0].querySelector("a")?.textContent,
          code: bubbles[0].querySelector("code.inlinecode")?.textContent,
          localImages: [...bubbles[0].querySelectorAll("img")].map(img => img.getAttribute("src")),
          remoteVisible: bubbles[0].textContent.includes("![remote](https://remote.invalid/thread.png)"),
          fallbackVisible: bubbles[0].textContent.includes("legacy fallback"),
          userEmphasis: bubbles[1].querySelector("em")?.textContent,
          rules: bubbles[0].querySelectorAll("hr").length,
          whiteSpace: getComputedStyle(bubbles[0]).whiteSpace,
          activeAttributes,
          pwned: globalThis.__quickPwned,
        };
      });
      assert.deepEqual(result, {
        bubbleCount: 2,
        cardmdCount: 2,
        heading: "Thread heading",
        link: "named",
        code: "code",
        localImages: ["/uploads/thread.png"],
        remoteVisible: true,
        fallbackVisible: false,
        userEmphasis: "user emphasis",
        rules: 1,
        whiteSpace: "normal",
        activeAttributes: [],
        pwned: 0,
      });
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });
}

for (const pageName of ["index.html", "page.html"]) {
  test(`${pageName} reply-history thread call site uses shared safe Markdown`, async () => {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(String(error)));
    try {
      const suffix = pageName === "page.html" ? "?mock=1" : "";
      await page.goto(`${origin}/${pageName}${suffix}`, { waitUntil: "domcontentloaded" });
      const result = await page.evaluate(async board => {
        globalThis.__historyPwned = 0;
        const id = "browser-history-proof";
        const card = document.createElement("article");
        card.className = "box";
        const reply = document.createElement("div");
        reply.className = "reply cardmd";
        reply.dataset.raw = "Live reply";
        reply.textContent = reply.dataset.raw;
        card.appendChild(reply);
        document.body.appendChild(card);
        els[id] = {
          box: card,
          reply,
          histPos: document.createElement("span"),
          histUp: document.createElement("button"),
          histDown: document.createElement("button"),
        };
        selectedId = id;
        hist = null;
        delete histCache[id];
        const rich = [
          "# Older reply", "", "[named](https://example.com) and `code`", "",
          "![local](/uploads/history.png)",
          "![remote](https://remote.invalid/history.png)", "", "- list", "", "---", "",
          '[hostile](https://safe.invalid/x" onmouseover="globalThis.__historyPwned=1)',
        ].join("\n");
        const nativeFetch = globalThis.fetch;
        globalThis.fetch = async (input, options) => {
          if (String(input).startsWith("/thread?box=" + id)) {
            return { json: async () => ({ messages: [
              { kind: "agent", ts: 10, text: "legacy fallback", replyFull: rich },
              { kind: "agent", ts: 11, text: "Live reply", replyFull: "Live reply" },
            ] }) };
          }
          return nativeFetch(input, options);
        };
        await (board ? histStep(selectedId, 1) : histStep(1));   // the board's shared histStep names the card
        globalThis.fetch = nativeFetch;
        for (const node of reply.querySelectorAll("a, img")) {
          for (const type of ["click", "load", "error", "mouseover"])
            node.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
        }
        const activeAttributes = [...reply.querySelectorAll("*")].flatMap(node =>
          [...node.attributes].filter(attribute => /^on/i.test(attribute.name))
            .map(attribute => attribute.name));
        return {
          historyView: card.classList.contains("histview"),
          cardmd: reply.classList.contains("cardmd"),
          heading: reply.querySelector("h1")?.textContent,
          link: reply.querySelector("a")?.textContent,
          code: reply.querySelector("code.inlinecode")?.textContent,
          images: [...reply.querySelectorAll("img")].map(img => img.getAttribute("src")),
          remoteVisible: reply.textContent.includes("![remote](https://remote.invalid/history.png)"),
          fallbackVisible: reply.textContent.includes("legacy fallback"),
          lists: reply.querySelectorAll("ul").length,
          rules: reply.querySelectorAll("hr").length,
          activeAttributes,
          pwned: globalThis.__historyPwned,
        };
      }, pageName === "index.html");
      assert.deepEqual(result, {
        historyView: true,
        cardmd: true,
        heading: "Older reply",
        link: "named",
        code: "code",
        images: ["/uploads/history.png"],
        remoteVisible: true,
        fallbackVisible: false,
        lists: 1,
        rules: 1,
        activeAttributes: [],
        pwned: 0,
      });
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });
}

test("index alternate thread call site uses shared safe Markdown", async () => {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  try {
    await page.goto(`${origin}/index.html`, { waitUntil: "domcontentloaded" });
    const result = await page.evaluate(() => {
      globalThis.__alternatePwned = 0;
      activeOwner = C3_LANE;
      chatBuild();
      c3Out = [];
      c3Msgs = [{
        kind: "agent", ts: 200, text: "legacy fallback", replyFull: [
          "# Alternate", "", "[named](https://example.com) and `code`", "",
          "![local](/uploads/alternate.png)",
          "![remote](https://remote.invalid/alternate.png)", "", "> quote", "", "- list", "",
          "| A | B |", "| --- | --- |", "| x | y |", "", "---", "",
          '[hostile](https://safe.invalid/x" onfocus="globalThis.__alternatePwned=1)',
        ].join("\n"),
      }];
      c3Sig = "";
      chatDraw(true);
      const bubble = document.querySelector("#magic3 .c3msg");
      for (const node of bubble.querySelectorAll("a, img")) {
        for (const type of ["click", "load", "error", "focus"])
          node.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
      }
      const activeAttributes = [...bubble.querySelectorAll("*")].flatMap(node =>
        [...node.attributes].filter(attribute => /^on/i.test(attribute.name))
          .map(attribute => attribute.name));
      return {
        cardmd: bubble.classList.contains("cardmd"),
        heading: bubble.querySelector("h1")?.textContent,
        link: bubble.querySelector("a")?.textContent,
        code: bubble.querySelector("code.inlinecode")?.textContent,
        images: [...bubble.querySelectorAll("img")].map(img => img.getAttribute("src")),
        remoteVisible: bubble.textContent.includes("![remote](https://remote.invalid/alternate.png)"),
        fallbackVisible: bubble.textContent.includes("legacy fallback"),
        quote: bubble.querySelectorAll("blockquote").length,
        list: bubble.querySelectorAll("ul").length,
        table: bubble.querySelectorAll("table").length,
        rule: bubble.querySelectorAll("hr").length,
        whiteSpace: getComputedStyle(bubble).whiteSpace,
        activeAttributes,
        pwned: globalThis.__alternatePwned,
      };
    });
    assert.deepEqual(result, {
      cardmd: true,
      heading: "Alternate",
      link: "named",
      code: "code",
      images: ["/uploads/alternate.png"],
      remoteVisible: true,
      fallbackVisible: false,
      quote: 1,
      list: 1,
      table: 1,
      rule: 1,
      whiteSpace: "normal",
      activeAttributes: [],
      pwned: 0,
    });
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("page document view formats every pending message through the real surface", async () => {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  try {
    await page.goto(`${origin}/page.html?doc=1&mock=1`, { waitUntil: "domcontentloaded" });
    const result = await page.evaluate(() => {
      const first = docMockState.boxes[0];
      first.pendingTexts = [
        "# Pending\n\n*italic* and [link](https://example.com)\n\n- one\n- two\n\n```js\nconst x = 1;\n```",
        "Second\n\n---",
      ];
      first.pending = first.pendingTexts.length;
      docMockPaint();
      const host = document.querySelector('.docsec[data-id="m1"] .docpend');
      const heading = host.querySelector("h1");
      return {
        messages: host.querySelectorAll(".docpending-message").length,
        headings: host.querySelectorAll("h1").length,
        emphasis: host.querySelectorAll("em").length,
        links: host.querySelectorAll("a").length,
        lists: host.querySelectorAll("ul").length,
        fences: host.querySelectorAll("pre.codeblock").length,
        rules: host.querySelectorAll("hr").length,
        headingFamily: getComputedStyle(heading).fontFamily,
        visible: getComputedStyle(host).display !== "none",
      };
    });
    assert.deepEqual(result, {
      messages: 2, headings: 1, emphasis: 1, links: 1, lists: 1,
      fences: 1, rules: 1,
      headingFamily: "Inter, -apple-system, sans-serif",
      visible: true,
    });
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("every pending surface calls the shared formatter", async () => {
  const index = await readFile(path.join(ROOT, "index.html"), "utf8");
  const logic = await readFile(path.join(ROOT, "card-logic.js"), "utf8");
  const page = await readFile(path.join(ROOT, "page.html"), "utf8");
  assert.match(logic, /h\("div", "pendcontent cardmd"\)[\s\S]*?content\.innerHTML = fmt\(text\)/);
  assert.match(index, /class="mpending-message cardmd"[^\n]+fmt\(t\)/);
  assert.match(page, /h\("div", "pending-message cardmd"\)[\s\S]*?content\.innerHTML = fmt\(text\)/);
  assert.match(page, /class="pending-message cardmd"[^\n]+fmt\(t\)/);
  assert.match(page, /class="docpending-message"[^\n]+fmt\(t\)/);
});

test("browser coverage inventory includes every thread fetch call site", async () => {
  const index = await readFile(path.join(ROOT, "index.html"), "utf8");
  const logic = await readFile(path.join(ROOT, "card-logic.js"), "utf8");
  const page = await readFile(path.join(ROOT, "page.html"), "utf8");
  assert.equal((index.match(/fetch\("\/thread\?box=/g) || []).length, 2,
    "index gained an unreviewed thread renderer");
  assert.equal((logic.match(/fetch\("\/thread\?box=/g) || []).length, 1,
    "the shared card logic gained an unreviewed thread renderer");
  assert.equal((page.match(/fetch\("\/thread\?box=/g) || []).length, 2,
    "page gained an unreviewed thread renderer");
  assert.match(logic, /el\.reply\.innerHTML = fmt\(list\[list\.length - step\]\)/);
  assert.match(page, /el\.reply\.innerHTML = fmt\(list\[list\.length - step\]\)/);
  assert.match(index, /bubble\.innerHTML = fmt\(m\.kind === "user"/);
  assert.match(page, /bubble\.innerHTML = fmt\(m\.kind === "user"/);
  assert.match(index, /else msg\.innerHTML = fmt\(b\.text\)/);
});
