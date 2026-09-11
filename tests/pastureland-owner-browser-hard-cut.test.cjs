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

const box = (id, owner, title) => ({
  id, bucket: "meta", title, reply: "", done: false, replies: 0,
  ball: "you", parked: false, ts: 0, context: "", owner,
  pending: 0, pendingTexts: [], pendingStamps: [], ws: "w1", task: null,
  worktree: "", agentTs: 0, engine: "claude", writing: false, bg: false,
  state: "new", queuePos: 0,
});

const workspace = owner => ({
  id: "w1", name: "main", started: 0, goal: `${owner} goal`, tasks: [], current: null,
});

const STATE = {
  boxes: [
    box("0", "facilitator", "Facilitator meta"),
    box("t0", "pastureland", "Pastureland meta"),
    box("q", "qchat", "Quick chat"),
  ],
  pwd: "/tmp/facilitator",
  pwds: {
    facilitator: "/tmp/facilitator",
    pastureland: "/tmp/pastureland",
    qchat: "/tmp/facilitator",
  },
  projects: [],
  busy: { facilitator: null, pastureland: null, qchat: null },
  queued: 0,
  end: false,
  paused: false,
  title: "owner browser hard cut",
  listening: { facilitator: false, pastureland: false, qchat: false },
  everListened: {},
  workspaces: {
    facilitator: [workspace("facilitator")],
    pastureland: [workspace("pastureland")],
    qchat: [workspace("qchat")],
  },
  listenerGap: { facilitator: 9999, pastureland: 9999, qchat: 9999 },
  agents: {
    facilitator: { name: "claude", alive: false, offrecord: false },
    pastureland: { name: "claude", alive: false, offrecord: false },
    qchat: { name: "claude", alive: false, offrecord: false },
  },
};

before(async () => {
  server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      const shared = {
        "/card-markdown.js": "text/javascript; charset=utf-8",
        "/card-tokens.css": "text/css; charset=utf-8",
        "/card-logic.js": "text/javascript; charset=utf-8",
        "/card-report.js": "text/javascript; charset=utf-8",
        "/compose-format.js": "text/javascript; charset=utf-8",
        "/cm-markdown.js": "text/javascript; charset=utf-8",
      };
      if (Object.hasOwn(shared, url.pathname)) {
        res.setHeader("content-type", shared[url.pathname]);
        res.end(await readFile(path.join(ROOT, url.pathname.slice(1))));
        return;
      }
      const files = {
        "/": "index.html",
        "/index.html": "index.html",
        "/page": "page.html",
        "/page.html": "page.html",
        "/setup.html": null,
      };
      if (Object.hasOwn(files, url.pathname)) {
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(files[url.pathname] === null
          ? "<!doctype html><title>setup</title>"
          : await readFile(path.join(ROOT, files[url.pathname])));
        return;
      }
      if (url.pathname === "/state") {
        const referer = new URL(req.headers.referer || "http://127.0.0.1");
        const state = referer.searchParams.get("fixture") === "retired-state"
          ? { ...STATE, pwds: { ...STATE.pwds, triage: "/tmp/retired" } }
          : STATE;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(state));
        return;
      }
      if (url.pathname === "/thread") {
        res.setHeader("content-type", "application/json");
        res.end('{"messages":[]}');
        return;
      }
      if (url.pathname === "/worktrees") {
        res.setHeader("content-type", "application/json");
        res.end('{"current":"","names":[]}');
        return;
      }
      if (url.pathname === "/mdfiles") {
        res.setHeader("content-type", "application/json");
        res.end('{"roots":[]}');
        return;
      }
      res.statusCode = 404;
      res.end("not found");
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

async function preparedPage(storage, options = {}) {
  const page = await browser.newPage();
  await page.goto(`${origin}/setup.html`, { waitUntil: "domcontentloaded" });
  await page.evaluate(entries => {
    localStorage.clear();
    for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
  }, storage);
  const requests = [];
  page.on("request", request => requests.push(request.url()));
  let heldState = null;
  let stateSeen = null;
  if (options.holdState) {
    await page.setRequestInterception(true);
    stateSeen = new Promise(resolve => {
      page.on("request", request => {
        if (!heldState && new URL(request.url()).pathname === "/state") {
          heldState = request;
          resolve();
        } else {
          request.continue().catch(() => {});
        }
      });
    });
  }
  return {
    page,
    requests,
    stateSeen,
    releaseState: async () => {
      if (!heldState) return;
      const request = heldState;
      heldState = null;
      await request.continue();
    },
  };
}

function retiredOwnerRequests(requests) {
  return requests.filter(raw => {
    const url = new URL(raw);
    return url.searchParams.get("owner") === "triage" ||
      url.searchParams.get("lane") === "triage" ||
      url.pathname === "/laneimg/triage" || url.pathname.startsWith("/laneimg/triage/");
  });
}

const retiredStorage = {
  activeproj: "triage",
  taborder: '["triage","pastureland","facilitator"]',
  "tabhide.triage": "1",
  "pos.triage.main": '{"x":1,"y":2}',
  "size.triage.main": '{"w":3,"h":4}',
  "hide.triage.main": "1",
  "minibox.triage": "old-card",
  "doc.tasks.triage": '[{"title":"old"}]',
  "layoutbak.pos.triage.main": '{"x":5,"y":6}',
  "layoutbak.size.triage.main": '{"w":7,"h":8}',
};

for (const pageName of ["index.html", "page.html"]) {
  test(`${pageName} purges retired owner storage and chooses a valid default`, async () => {
    const { page, requests } = await preparedPage(retiredStorage);
    try {
      await page.goto(`${origin}/${pageName}`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() =>
        activeOwner === "facilitator" &&
        !!document.querySelector('#tabbar [data-owner="facilitator"].on'),
      { timeout: 5000 });
      const result = await page.evaluate(keys => ({
        runtimeOwner: activeOwner,
        storedOwner: localStorage.getItem("activeproj"),
        order: JSON.parse(localStorage.getItem("taborder") || "[]"),
        retiredValues: keys.map(key => [key, localStorage.getItem(key)]),
        retiredTabs: document.querySelectorAll('#tabbar [data-owner="triage"]').length,
        refusal: document.getElementById("owner-refused")?.textContent || "",
      }), Object.keys(retiredStorage).filter(key => !["activeproj", "taborder"].includes(key)));
      assert.equal(result.runtimeOwner, "facilitator");
      assert.equal(result.storedOwner, null, "the retired active owner was retained or remapped");
      assert.deepEqual(result.order, ["pastureland", "facilitator"]);
      assert.ok(result.retiredValues.every(([, value]) => value === null),
        `retired storage survived: ${JSON.stringify(result.retiredValues)}`);
      assert.equal(result.retiredTabs, 0);
      assert.equal(result.refusal, "");
      assert.deepEqual(retiredOwnerRequests(requests), [],
        "the page issued an owner-scoped request for the retired owner");
    } finally {
      await page.close();
    }
  });

  test(`${pageName} validates an arbitrary stale active owner against state`, async () => {
    const fixture = await preparedPage({ activeproj: "missing-owner" }, { holdState: true });
    const { page, requests } = fixture;
    try {
      await page.goto(`${origin}/${pageName}`, { waitUntil: "domcontentloaded" });
      await fixture.stateSeen;
      await page.keyboard.down("Meta");
      await page.keyboard.press("t");
      await page.keyboard.up("Meta");
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(requests.some(raw => new URL(raw).searchParams.get("owner") === "missing-owner"),
        false, "the unvalidated active owner was used before state arrived");
      await fixture.releaseState();
      await page.waitForFunction(() => activeOwner === "facilitator", { timeout: 5000 });
      const result = await page.evaluate(() => ({
        runtimeOwner: activeOwner,
        storedOwner: localStorage.getItem("activeproj"),
        staleTabs: document.querySelectorAll('#tabbar [data-owner="missing-owner"]').length,
      }));
      assert.deepEqual(result,
        { runtimeOwner: "facilitator", storedOwner: null, staleTabs: 0 });
      assert.equal(requests.some(raw => new URL(raw).searchParams.get("owner") === "missing-owner"),
        false, "the page used an active owner that was absent from state");
    } finally {
      await fixture.releaseState().catch(() => {});
      await page.close();
    }
  });

  test(`${pageName} visibly refuses project=triage without owner-scoped traffic`, async () => {
    const { page, requests } = await preparedPage({});
    try {
      const stateResponse = page.waitForResponse(
        response => new URL(response.url()).pathname === "/state",
      );
      await page.goto(`${origin}/${pageName}?project=triage`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#owner-refused");
      await stateResponse;
      const result = await page.evaluate(() => ({
        message: document.getElementById("owner-refused")?.textContent || "",
        lane: document.body.dataset.lane || "",
        retiredTabs: document.querySelectorAll('#tabbar [data-owner="triage"]').length,
      }));
      assert.match(result.message, /Project "triage" is not available/);
      assert.equal(result.lane, "", "the refused owner was rendered as an active lane");
      assert.equal(result.retiredTabs, 0);
      assert.deepEqual(retiredOwnerRequests(requests), [],
        "the refused project issued an owner-scoped request");
    } finally {
      await page.close();
    }
  });

  test(`${pageName} refuses retired owner data received from state`, async () => {
    const { page, requests } = await preparedPage({});
    try {
      await page.goto(`${origin}/${pageName}?fixture=retired-state`,
        { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() =>
        document.getElementById("owner-refused")?.textContent.includes("must be migrated"),
      { timeout: 5000 });
      const result = await page.evaluate(() => ({
        message: document.getElementById("owner-refused")?.textContent || "",
        renderedTabs: document.querySelectorAll("#tabbar [data-owner]").length,
      }));
      assert.match(result.message, /retired owner.*migrated/);
      assert.equal(result.renderedTabs, 0, "stale server state rendered owner tabs");
      assert.deepEqual(retiredOwnerRequests(requests), [],
        "stale server state caused a retired owner request");
    } finally {
      await page.close();
    }
  });
}
