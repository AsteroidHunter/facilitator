// A widget's page talking with the Mac board, in a real browser: a click and
// Enter in the page send the person's message, which reaches the card's agent
// as a widget message; the agent's answer reaches the open page with no
// reload; a page's send with no click of the person's is refused; the page
// still reaches no network; and a page that is not a widget is not heard. Its
// own headless Chrome on a copy of the board on spare ports.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const puppeteer = require("puppeteer-core");
const { startBoard } = require("./board-fixture.cjs");

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SEED = { title: "widget browser fixture", items: [
  { id: "w1", bucket: "now", title: "Widget card", owner: "facilitator" },
  { id: "w2", bucket: "now", title: "Probe card", owner: "facilitator" },
  { id: "w3", bucket: "now", title: "Plain page card", owner: "facilitator" },
  { id: "w4", bucket: "now", title: "Keys card", owner: "facilitator" },
] };
// a small widget: a field, a button that sends what it holds about "t7", and
// the thread as the board tells it
const WIDGET = `<!doctype html><textarea id=field></textarea><button id=send>Send</button><ol id=thread></ol><script>
  const draw = d => { thread.replaceChildren(...d.thread.map(m => Object.assign(document.createElement("li"), { textContent: m.by + ": " + m.text }))); };
  facilitator.on("data", draw);
  facilitator.ready().then(draw);
  const go = () => facilitator.send(field.value, "t7").then(() => { field.value = ""; document.body.dataset.sent = "yes"; },
    e => { document.body.dataset.sent = String(e.code); });
  send.addEventListener("click", go);
  field.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); go(); } });
</script>`;
let board, browser, page, home;

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const agent = async (method, route, body) => {
  const r = await fetch(board.origin + route, { method, body });
  return { status: r.status, body: await r.json().catch(() => null) };
};
// the page the box shows, in its holder (MagicBox.holderDoc), never the hidden
// copy the board measures the page in
async function shown(marker) {
  for (let i = 0; i < 100; i++) {
    const el = await page.$("#magicbox iframe.mbframe");
    const holder = el && await el.contentFrame();
    for (const frame of holder ? [holder, ...holder.childFrames()] : [])
      if (await frame.$(marker).catch(() => null)) return frame;
    await pause(100);
  }
  throw new Error("the box shows no page with " + marker);
}
async function open(id) {
  await page.evaluate(card => select(card), id);
  await page.waitForFunction(card => MB.id === card && document.getElementById("magicbox").classList.contains("on"), {}, id);
}

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "facilitator-widget-home-"));
  board = await startBoard({ seed: SEED, extra: ["hover-labels.js"], env: { HOME: home } });
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true,
    args: ["--use-mock-keychain", "--password-store=basic", "--no-first-run", "--disable-background-networking"] });
  page = await browser.newPage();
  await page.setViewport({ width: 1512, height: 949 });
  await agent("POST", "/magic?box=w1&kind=html&widget=demo", WIDGET);
  await page.goto(board.origin + "/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.body.classList.contains("layout-ready") && typeof lastState !== "undefined" && lastState);
});
after(async () => {
  if (browser) await browser.close();
  if (board) await board.stop();
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

test("a click and Enter in the page send; the agent's answer reaches the open page with no reload", async () => {
  await open("w1");
  const frame = await shown("#field");
  await frame.click("#field");
  await page.keyboard.type("Is this one still needed?");
  await page.keyboard.press("Enter");
  await frame.waitForFunction(() => document.body.dataset.sent === "yes", { timeout: 10000 });
  const claim = (await agent("GET", "/wait?owner=facilitator&timeout=12")).body;
  assert.equal(claim.box, "w1");
  assert.deepEqual(claim.messages, []);
  assert.deepEqual(claim.widget_messages.map(({ ts, ...m }) => m),
    [{ from: "widget", widget: "demo", about: "t7", text: "Is this one still needed?" }]);
  assert.equal((await agent("POST", `/ack?owner=facilitator&token=${claim.ack}`)).status, 200);
  await frame.evaluate(() => { window.stillHere = true; });
  const answer = await agent("POST", "/magic/answer?box=w1&about=t7", "Yes, still needed.");
  assert.equal(answer.body.released, true);
  await frame.waitForFunction(() => document.getElementById("thread").textContent.includes("agent: Yes, still needed."), { timeout: 10000 });
  assert.equal(await frame.evaluate(() => window.stillHere), true, "the page was loaded again");
  const card = (await (await fetch(board.origin + "/state")).json()).boxes.find(b => b.id === "w1");
  assert.deepEqual(card.pendingTexts, []);
  assert.equal(card.replies, 0, "the answer landed on the card");
});

test("a page's send with no click of the person's is refused, and the page reaches no network", async () => {
  await agent("POST", "/magic?box=w2&kind=html&widget=probe", `<!doctype html><p id=out>waiting</p><script>
    setTimeout(() => facilitator.send("sent with no click", "x").then(() => { out.textContent = "sent"; },
      e => { out.textContent = String(e.code); }), 6000);
    fetch(${JSON.stringify(board.origin + "/state")}).then(() => { out.dataset.net = "reached"; }, () => { out.dataset.net = "blocked"; });
  </script>`);
  await pause(1500);
  await open("w2");
  // the pointer rests on the box, so the missing click is all that stops it
  const at = await page.$eval("#magicbox", e => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await page.mouse.move(at.x, at.y);
  const frame = await shown("#out");
  await frame.waitForFunction(() => document.getElementById("out").textContent !== "waiting", { timeout: 15000 });
  assert.deepEqual(await frame.$eval("#out", e => [e.textContent, e.dataset.net]), ["-32001", "blocked"]);
  assert.equal((await agent("GET", "/wait?owner=facilitator&timeout=4")).body.idle, true);
});

test("keys typed on the card with the pointer resting on the box let no page send; a click on the page's button does", async () => {
  await agent("POST", "/magic?box=w4&kind=html&widget=keys", `<!doctype html><button id=ok>Yes</button><p id=out></p><script>
    const said = [];
    const tick = setInterval(() => facilitator.send("sent by a timer", "x").then(() => said.push("sent"), e => said.push(String(e.code))), 400);
    setTimeout(() => clearInterval(tick), 7000);
    ok.addEventListener("click", () => facilitator.send("yes", "t1").then(() => { out.dataset.ok = "sent"; }, e => { out.dataset.ok = String(e.code); }));
    setInterval(() => { out.textContent = said.join(","); }, 100);
  </script>`);
  await pause(1500);
  await open("w4");
  const frame = await shown("#ok");
  const at = await page.$eval("#magicbox", e => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await page.mouse.move(at.x, at.y);
  // the person types on the card, the pointer resting on the box
  await page.evaluate(() => els.w4.ta.focus());
  await page.keyboard.type("words typed on the card, not in the box", { delay: 120 });
  await pause(1500);
  const said = (await frame.$eval("#out", e => e.textContent)).split(",");
  assert.ok(said.length >= 8 && said.every(s => s === "-32001"), said.join(","));
  assert.equal((await agent("GET", "/wait?owner=facilitator&timeout=4")).body.idle, true);
  // the timer has stopped; a click on the page's own button sends
  await frame.click("#ok");
  await frame.waitForFunction(() => document.getElementById("out").dataset.ok, { timeout: 10000 });
  assert.equal(await frame.$eval("#out", e => e.dataset.ok), "sent");
  const claim = (await agent("GET", "/wait?owner=facilitator&timeout=12")).body;
  assert.deepEqual(claim.widget_messages.map(m => m.text), ["yes"]);
  await agent("POST", `/ack?owner=facilitator&token=${claim.ack}`);
  assert.equal((await agent("POST", "/magic/answer?box=w4&about=t1", "Noted.")).body.released, true);
});

test("a page that is not a widget has no way to talk, and what it posts is not heard", async () => {
  await agent("POST", "/magic?box=w3&kind=html", `<!doctype html><button id=go>go</button><p id=out></p><script>
    out.textContent = typeof window.facilitator;
    go.addEventListener("click", () => parent.postMessage({ jsonrpc: "2.0", id: "plainpage01", method: "widget/send",
      params: { text: "from a plain page", about: "x" } }, "*"));
  </script>`);
  await pause(1500);
  const asked = [];
  page.on("request", r => { if (/\/magic\/(send|state|widget)/.test(r.url())) asked.push(r.url()); });
  await open("w3");
  const frame = await shown("#go");
  assert.equal(await frame.$eval("#out", e => e.textContent), "undefined");
  await frame.click("#go");
  await pause(1500);
  assert.deepEqual(asked, []);
  assert.equal((await agent("GET", "/wait?owner=facilitator&timeout=4")).body.idle, true);
});
