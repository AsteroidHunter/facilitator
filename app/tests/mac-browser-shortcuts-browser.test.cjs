// Native DOM propagation and real CodeMirror on a synthetic board. All inputs
// are dispatched KeyboardEvents, so a failing guard cannot open native dialogs,
// navigate, reload or close a browser. Connect-only; no new context/window.
const assert = require("node:assert/strict");
const { before, after, test } = require("node:test");
const puppeteer = require("puppeteer-core");
const { startBoard } = require("./board-fixture.cjs");
let browser, session, board, id;
const targets = new Set();
before(async () => {
  browser = await puppeteer.connect({ browserURL: process.env.CHROME_CDP_URL || "http://127.0.0.1:9222", defaultViewport: null });
  session = await browser.target().createCDPSession();
  const { targetInfos } = await session.send("Target.getTargets");
  assert.ok(targetInfos.some(t => t.type === "page"), "no existing test-browser window; creation stopped");
  board = await startBoard();
  const created = await board.call("POST", "/create?owner=facilitator", "Shortcut fixture card");
  assert.equal(created.status, 200); id = JSON.parse(created.text).id;
});
after(async () => {
  for (const targetId of targets) { try { await session.send("Target.closeTarget", { targetId }); } catch {} }
  if (session) await session.detach();
  if (browser) await browser.disconnect();
  if (board) await board.stop();
});
async function page(route = "/") {
  const { targetInfos } = await session.send("Target.getTargets");
  assert.ok(targetInfos.some(t => t.type === "page"), "existing window disappeared; stopped");
  let wanted, receive, timer;
  const seen = [];
  const found = new Promise((resolve, reject) => {
    receive = resolve; timer = setTimeout(() => reject(new Error("background target did not attach")), 10000);
  });
  const created = target => target._targetId === wanted ? receive(target) : seen.push(target);
  browser.on("targetcreated", created);
  let tab;
  try {
    const { targetId } = await session.send("Target.createTarget", { url: "about:blank", background: true, newWindow: false });
    wanted = targetId; targets.add(targetId);
    const early = seen.find(t => t._targetId === targetId); if (early) receive(early);
    tab = await (await found).page();
  } finally { clearTimeout(timer); browser.off("targetcreated", created); found.catch(() => {}); }
  await tab.setViewport({ width: 1512, height: 982 });
  await tab.evaluateOnNewDocument(() => { try { localStorage.clear(); } catch {} });
  await tab.goto(board.origin + route, { waitUntil: "domcontentloaded" });
  await tab.waitForFunction(() => typeof lastState !== "undefined" && lastState, { polling: 100 });
  if (route === "/") {
    assert.equal(await tab.evaluate(() => /^Mac/.test(navigator.platform) || navigator.userAgentData?.platform === "macOS"), true,
      "this regression must use a Mac browser");
    await tab.evaluate(card => { setHome(false); select(card); }, id);
  }
  return tab;
}
const blocked = [
  { key: "s", code: "KeyS" }, { key: "p", code: "KeyP" }, { key: "π", code: "KeyP", altKey: true },
  { key: ".", code: "Period" }, { key: "g", code: "KeyG" }, { key: "G", code: "KeyG", shiftKey: true },
  { key: "e", code: "KeyE" }, { key: "=", code: "Equal" }, { key: "+", code: "Equal", shiftKey: true },
  { key: "-", code: "Minus" }, { key: "0", code: "Digit0" }, { key: "[", code: "BracketLeft" }, { key: "]", code: "BracketRight" },
  { key: "Dead", code: "KeyI", altKey: true }, { key: "∆", code: "KeyJ", altKey: true }, { key: "ç", code: "KeyC", altKey: true },
  { key: "C", code: "KeyC", shiftKey: true }, { key: "F12", code: "F12", metaKey: false }, { key: "F7", code: "F7", metaKey: false },
  { key: "n", code: "KeyN" }, { key: "N", code: "KeyN", shiftKey: true }, { key: "y", code: "KeyY" },
  { key: "J", code: "KeyJ", shiftKey: true }, { key: "¬", code: "KeyL", altKey: true }, { key: "∫", code: "KeyB", altKey: true },
  { key: "Backspace", code: "Backspace", shiftKey: true }, { key: ",", code: "Comma" }, { key: "?", code: "Slash", shiftKey: true },
];
const kept = [
  { key: "f", code: "KeyF" }, { key: "r", code: "KeyR" }, { key: "R", code: "KeyR", shiftKey: true },
  ...["c", "x", "v", "a", "z", "w", "q", "h", "m"].map(key => ({ key, code: "Key" + key.toUpperCase() })),
  { key: "Z", code: "KeyZ", shiftKey: true }, { key: "W", code: "KeyW", shiftKey: true },
];
async function keys(tab, selector, list) {
  return tab.evaluate((sel, bindings) => {
    const target = document.querySelector(sel), seen = [];
    const watch = e => seen.push(e.defaultPrevented);
    target.addEventListener("keydown", watch, true);
    const results = bindings.map(binding => {
      const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, metaKey: true, ...binding });
      target.dispatchEvent(e); return e.defaultPrevented;
    });
    target.removeEventListener("keydown", watch, true);
    return { results, seen };
  }, selector, list);
}

test("audited defaults cancel across native DOM on board, Home, titles and settings while exceptions survive", async () => {
  const tab = await page();
  try {
    for (const mode of ["board", "home", "title", "settings"]) {
      const selector = await tab.evaluate(({ mode, id }) => {
        if (mode === "home") setHome(true);
        if (mode === "title") { setHome(false); editTitle(id); }
        if (mode === "settings") {
          if (els[id].titleEl.isContentEditable) els[id].titleEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
          document.getElementById("setbtn").click();
        }
        return mode === "title" ? "#box-" + id + " [contenteditable]" : mode === "settings" ? ".sp-veil.open .sp-page" : "body";
      }, { mode, id });
      const blockedResult = await keys(tab, selector, blocked);
      assert.ok(blockedResult.results.every(Boolean), mode + " leaked a browser default: " + JSON.stringify(blockedResult));
      assert.ok(blockedResult.seen.every(v => !v), mode + " saw cancellation before its own handlers");
      const keptResult = await keys(tab, selector, kept);
      assert.ok(keptResult.results.every(v => !v), mode + " blocked a preserved key");
    }
  } finally { await tab.close(); }
});

test("Escape retains the real card/title/settings actions and stops the browser default", async () => {
  const tab = await page();
  try {
    const result = await tab.evaluate(id => {
      const escape = target => { const e = new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }); target.dispatchEvent(e); return e.defaultPrevented; };
      const cardCanceled = escape(document.body), browsed = browsing;
      select(id); editTitle(id);
      const title = els[id].titleEl, old = title.textContent; title.textContent = "Unsaved name";
      const titleCanceled = escape(title), restored = title.textContent === old;
      const noLongerEditing = !title.isContentEditable;
      document.getElementById("setbtn").click();
      const settingsCanceled = escape(document.querySelector(".sp-veil.open .sp-page"));
      return { cardCanceled, browsed, titleCanceled, restored, noLongerEditing, settingsCanceled, settingsClosed: !setOpen };
    }, id);
    assert.ok(Object.values(result).every(Boolean), JSON.stringify(result));
  } finally { await tab.close(); }
});

test("CodeMirror loaded after the guard still saves and moves the caret; only nonediting Command+arrows are blocked", async () => {
  const tab = await page();
  try {
    const result = await tab.evaluate(async () => {
      fileNavMounts([activeOwner]); fileNavBoxes();
      const host = fileNavBuild(FILENAV_MOUNTS[activeOwner]); host.classList.remove("region-off");
      host.style.width = "400px"; host.style.height = "400px";
      if (!await fileNavBundle()) throw new Error("CodeMirror did not load");
      fileNavFor = activeOwner;
      fileNavOpen = { lane: activeOwner, root: "fixture", rel: "fixture.md", mtime: "1" };
      fileNavClean = "abc\ndef"; fileNavMount(host, fileNavClean, false); host.classList.add("editing");
      let saves = 0; fileNavSave = () => { saves++; };
      const send = (target, key, code) => { const e = new KeyboardEvent("keydown", { key, code, metaKey: true, bubbles: true, cancelable: true }); target.dispatchEvent(e); return e.defaultPrevented; };
      const saveCanceled = send(fileNavView.contentDOM, "s", "KeyS");
      fileNavView.dispatch({ selection: { anchor: 1 } });
      send(fileNavView.contentDOM, "ArrowRight", "ArrowRight");
      const caret = fileNavView.state.selection.main.head;
      const textarea = document.createElement("textarea"); document.body.appendChild(textarea);
      const caretDefaultKept = !send(textarea, "ArrowLeft", "ArrowLeft"); textarea.remove();
      const outsideCanceled = send(document.body, "ArrowLeft", "ArrowLeft");
      return { saves, saveCanceled, caret, caretDefaultKept, outsideCanceled };
    });
    assert.deepEqual(result, { saves: 1, saveCanceled: true, caret: 3, caretDefaultKept: true, outsideCanceled: true });
  } finally { await tab.close(); }
});

test("the PWA page retains its existing browser-key behavior", async () => {
  const tab = await page("/m?box=" + id);
  try {
    const result = await keys(tab, "body", [{ key: "s", code: "KeyS" }, { key: "p", code: "KeyP" }]);
    assert.deepEqual(result.results, [false, false]);
  } finally { await tab.close(); }
});
