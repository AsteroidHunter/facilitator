// A project lane's isolation on the desktop pages: an active owner the board
// does not have falls back to facilitator, a ?project lock naming a lane the
// board does not have is refused, and neither ever issues an owner-scoped
// request for the lane it could not use. Invented lane names only.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { readFile } = require("node:fs/promises");
const { createServer } = require("node:http");
const path = require("node:path");
const puppeteer = require("puppeteer-core");

const ROOT = path.resolve(__dirname, "..");
const CHROME = process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PROJECT = "orchard";   // a project lane the board does have

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
    box("m1", PROJECT, "Project meta"),
  ],
  pwd: "/tmp/facilitator",
  pwds: { facilitator: "/tmp/facilitator", [PROJECT]: "/tmp/" + PROJECT },
  projects: [],
  busy: { facilitator: null, [PROJECT]: null },
  queued: 0,
  title: "owner browser hard cut",
  listening: { facilitator: false, [PROJECT]: false },
  everListened: {},
  workspaces: { facilitator: [workspace("facilitator")], [PROJECT]: [workspace(PROJECT)] },
  listenerGap: { facilitator: 9999, [PROJECT]: 9999 },
  agents: {
    facilitator: { name: "claude", alive: false, offrecord: false },
    [PROJECT]: { name: "claude", alive: false, offrecord: false },
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
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(STATE));
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
      if (url.pathname === "/navfiles") {
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

function ownerRequests(requests, owner) {
  return requests.filter(raw => {
    const url = new URL(raw);
    return url.searchParams.get("owner") === owner ||
      url.searchParams.get("lane") === owner ||
      url.pathname === "/laneimg/" + owner || url.pathname.startsWith("/laneimg/" + owner + "/");
  });
}

for (const pageName of ["index.html", "page.html"]) {
  test(`${pageName} falls a stale active owner back to facilitator`, async () => {
    const fixture = await preparedPage({ activeproj: "missing-lane" }, { holdState: true });
    const { page, requests } = fixture;
    try {
      await page.goto(`${origin}/${pageName}`, { waitUntil: "domcontentloaded" });
      await fixture.stateSeen;
      await page.keyboard.down("Meta");
      await page.keyboard.press("t");
      await page.keyboard.up("Meta");
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(ownerRequests(requests, "missing-lane").length, 0,
        "an unvalidated active owner was used before state arrived");
      await fixture.releaseState();
      await page.waitForFunction(() => activeOwner === "facilitator", { timeout: 5000 });
      const result = await page.evaluate(() => ({
        runtimeOwner: activeOwner,
        storedOwner: localStorage.getItem("activeproj"),
        staleTabs: document.querySelectorAll('#tabbar [data-owner="missing-lane"]').length,
      }));
      assert.deepEqual(result, { runtimeOwner: "facilitator", storedOwner: null, staleTabs: 0 });
      assert.equal(ownerRequests(requests, "missing-lane").length, 0,
        "the page used an active owner absent from state");
    } finally {
      await fixture.releaseState().catch(() => {});
      await page.close();
    }
  });

  test(`${pageName} refuses a project lock the board does not have`, async () => {
    const { page, requests } = await preparedPage({});
    try {
      const stateResponse = page.waitForResponse(
        response => new URL(response.url()).pathname === "/state");
      await page.goto(`${origin}/${pageName}?project=nowhere`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#owner-refused");
      await stateResponse;
      const result = await page.evaluate(() => ({
        message: document.getElementById("owner-refused")?.textContent || "",
        lane: document.body.dataset.lane || "",
        laneTabs: document.querySelectorAll('#tabbar [data-owner="nowhere"]').length,
      }));
      assert.match(result.message, /Project "nowhere" is not available/);
      assert.equal(result.lane, "", "the refused owner was rendered as an active lane");
      assert.equal(result.laneTabs, 0);
      assert.equal(ownerRequests(requests, "nowhere").length, 0,
        "the refused project issued an owner-scoped request");
    } finally {
      await page.close();
    }
  });

  test(`${pageName} keeps a valid project lane as a selectable tab`, async () => {
    const { page } = await preparedPage({ activeproj: PROJECT });
    try {
      await page.goto(`${origin}/${pageName}`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(owner => activeOwner === owner, { timeout: 5000 }, PROJECT);
      const tabs = await page.evaluate(
        owner => document.querySelectorAll(`#tabbar [data-owner="${owner}"]`).length, PROJECT);
      assert.ok(tabs > 0, "a valid project lane was not offered as a tab");
    } finally {
      await page.close();
    }
  });
}
