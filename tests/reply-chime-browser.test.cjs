// The reply chime on the Mac board and the bell that mutes it. The page's audio
// context is a recording stand-in that, like Chrome, plays only after a click or
// key press, so a test can count chimes and read the sound each one built. Replies
// are real ones, posted to a throwaway board, and reach the page through its own
// readings of the board. The page's clock is moved forward to cross the two minute
// gap and the window's front or back is set by the page's own two questions.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { launch } = require("./resp-harness.cjs");

const ROOT = path.resolve(__dirname, "..");
const VIEW = { width: 1512, height: 982 };
const SHOTS = process.env.CHIME_SHOTS || "";
const MINUTE = 60 * 1000;

let fx;
let garden;
let orchard;
let made = 0;

before(async () => {
  fx = await launch({ files: ["board-settings.js"] });
  garden = await fx.makeProject("Garden Notes");
  orchard = await fx.makeProject("Orchard Plans");
});
after(async () => { if (fx) await fx.stop(); });

// runs in the page before its own scripts
function installStubs(armed) {
  const real = Date.now.bind(Date);
  window.__skew = 0;
  Date.now = () => real() + window.__skew;
  window.__front = { focus: true, visible: true };
  document.hasFocus = () => window.__front.focus;
  Object.defineProperty(document, "visibilityState", { configurable: true,
    get: () => (window.__front.visible ? "visible" : "hidden") });

  const audio = { gesture: !!armed, made: 0, resumes: 0, contexts: [] };
  window.__audio = audio;
  for (const type of ["pointerdown", "keydown", "click"])
    addEventListener(type, () => { audio.gesture = true; }, true);
  const param = () => ({ value: 0, calls: [],
    setValueAtTime(v, t) { this.calls.push(["set", v, t]); return this; },
    linearRampToValueAtTime(v, t) { this.calls.push(["linear", v, t]); return this; },
    exponentialRampToValueAtTime(v, t) { this.calls.push(["exp", v, t]); return this; } });
  const node = extra => Object.assign({ to: [], connect(next) { this.to.push(next); return next; } }, extra);
  class Context {
    constructor() {
      audio.made++;
      this.state = audio.gesture ? "running" : "suspended";
      this.currentTime = 12.5;
      this.destination = { kind: "destination" };
      this.gains = [];
      this.oscs = [];
      audio.contexts.push(this);
    }
    createGain() { const n = node({ kind: "gain", gain: param() }); this.gains.push(n); return n; }
    createOscillator() {
      const n = node({ kind: "osc", type: "sine", frequency: param(),
        start(t) { this.startAt = t; }, stop(t) { this.stopAt = t; } });
      this.oscs.push(n);
      return n;
    }
    resume() { audio.resumes++; if (audio.gesture) this.state = "running"; return Promise.resolve(); }
  }
  window.AudioContext = Context;
  window.webkitAudioContext = Context;
  audio.rings = () => audio.contexts.flatMap(c => c.gains.filter(g => g.to.includes(c.destination))
    .map(master => ({
      volume: master.gain.value,
      notes: c.oscs.filter(o => o.to.some(g => g.to.includes(master))).map(o => ({
        type: o.type, freq: o.frequency.value, start: o.startAt, stop: o.stopAt, env: o.to[0].gain.calls })),
    })));
}

// the real audio context, watched and not replaced
function installSpy() {
  window.__front = { focus: true, visible: true };
  document.hasFocus = () => window.__front.focus;
  const Real = window.AudioContext;
  const seen = { made: 0, oscillators: 0, ctx: null };
  window.__spy = seen;
  window.AudioContext = class extends Real {
    constructor(...args) { super(...args); seen.made++; seen.ctx = this; }
    createOscillator() { seen.oscillators++; return super.createOscillator(); }
  };
}

const withStubs = armed => new Function("(" + installStubs.toString() + ")(" + !!armed + ");");
const withSpy = () => new Function("(" + installSpy.toString() + ")();");

async function open({ armed = true, prep, storage = null, viewport = VIEW } = {}) {
  const { context, page } = await fx.openBoard(storage, viewport, prep || withStubs(armed));
  const problems = [];
  page.on("console", m => {
    if (m.type() === "error" && !/fonts\.g(oogleapis|static)|Failed to load resource/.test(m.text())) problems.push(m.text());
  });
  page.on("pageerror", e => problems.push("pageerror: " + e.message));
  return { context, page, problems };
}

async function create(owner) {
  return (await fx.post("/create?owner=" + encodeURIComponent(owner), `Chime card ${++made}`)).id;
}

const turnOf = (page, id) => page.evaluate(
  id => (lastState.boxes.find(b => b.id === id) || {}).turnTs || 0, id);

// the agent answers each card; resolves once the page has read every answer
async function answer(page, ids) {
  const before = await Promise.all(ids.map(id => turnOf(page, id)));
  for (const id of ids) await fx.post(`/reply?box=${id}`, "An answer.");
  await page.waitForFunction((ids, before) => ids.every((id, i) => {
    const b = lastState.boxes.find(x => x.id === id);
    return b && b.turnTs > before[i];
  }), { timeout: 8000 }, ids, before);
}

async function replies(page, owner, n = 1) {
  const ids = [];
  for (let i = 0; i < n; i++) ids.push(await create(owner));
  await answer(page, ids);
  return ids;
}

const rings = page => page.evaluate(() => window.__audio.rings().length);
const nap = ms => new Promise(resolve => setTimeout(resolve, ms));
const skew = (page, ms) => page.evaluate(ms => { window.__skew = ms; }, ms);
const front = (page, focus, visible = true) => page.evaluate((focus, visible) => {
  window.__front = { focus, visible };
}, focus, visible);
const touch = page => page.mouse.click(VIEW.width / 2, 18);   // empty bar: a click and nothing else

async function show(page, owner) {
  await page.click(`#tabbar .ptab[data-owner="${owner}"]`);
  await page.waitForFunction(o => activeOwner === o, {}, owner);
}

async function beside(page) {
  await nap(1500);   // long enough for a reading of the board to come in
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
}

test("the pencil is gone, the edit code is kept, and the bell is a plain mark beside the gear", async () => {
  const { context, page, problems } = await open();
  try {
    const bar = await page.evaluate(() => {
      const dress = el => {
        const cs = getComputedStyle(el), box = el.getBoundingClientRect();
        const svg = el.querySelector("svg").getBoundingClientRect();
        return { color: cs.color, background: cs.backgroundColor, border: cs.borderTopStyle, shadow: cs.boxShadow,
          padding: cs.padding, mark: Math.round(svg.width) + "x" + Math.round(svg.height),
          w: box.width, h: box.height, mid: box.top + box.height / 2, left: box.left, right: box.right,
          inBar: !!el.closest(".bar") };
      };
      const slash = document.querySelector("#chimebtn .chime-slash");
      return { bell: dress(document.getElementById("chimebtn")), gear: dress(document.getElementById("setbtn")),
        pencil: document.getElementById("editbtn"), slash: getComputedStyle(slash).display,
        label: document.getElementById("chimebtn").getAttribute("aria-label"),
        title: document.getElementById("chimebtn").title,
        pressed: document.getElementById("chimebtn").getAttribute("aria-pressed"),
        editCode: typeof setEditMode };
    });
    assert.equal(bar.pencil, null, "the pencil is still on the bar");
    assert.equal(bar.bell.inBar, true);
    assert.equal(bar.bell.color, bar.gear.color, "the bell is not the gear's ink");
    assert.equal(bar.bell.background, "rgba(0, 0, 0, 0)");
    assert.equal(bar.bell.border, "none");
    assert.equal(bar.bell.shadow, "none");
    assert.equal(bar.bell.padding, bar.gear.padding);
    assert.equal(bar.bell.mark, "15x15");
    assert.equal(bar.bell.mark, bar.gear.mark);
    assert.equal(bar.bell.w, bar.gear.w);
    assert.equal(bar.bell.h, bar.gear.h);
    assert.ok(Math.abs(bar.bell.mid - bar.gear.mid) <= 0.5, "the bell and the gear are on one line");
    assert.ok(Math.abs(bar.bell.right + 14 - bar.gear.left) <= 0.6, "the bell sits 14px left of the gear");
    assert.equal(bar.slash, "none", "the slash shows while the chime is on");
    assert.equal(bar.pressed, "true");
    assert.equal(bar.label, "Reply chime");
    assert.match(bar.title, /chime on.*mute/i);
    assert.equal(bar.editCode, "function", "the edit mode code was taken out");

    // edit mode itself still works when something asks for it
    await page.evaluate(() => setEditMode(true));
    await page.waitForSelector('.rkill[data-region="clockbox"]', { visible: true });
    assert.equal(await page.evaluate(() => document.body.classList.contains("editmode")), true);
    await page.evaluate(() => setEditMode(false));
    assert.equal(await page.evaluate(() => document.body.classList.contains("editmode")), false);
    assert.deepEqual(problems, []);
  } finally { await context.close(); }
});

test("the bell's style uses no purple or blue, and the chime code has no em dash", async () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const style = html.split("\n").filter(line => /#chimebtn|chime-slash/.test(line) && !line.includes("<button")).join("\n");
  assert.ok(style.includes("#chimebtn"), "the bell's style rules were not found");
  assert.doesNotMatch(style, /--accent|432bff/i);
  const markup = html.split("\n").find(line => line.includes('id="chimebtn"'));
  assert.ok(markup, "the bell's markup was not found");
  assert.doesNotMatch(markup, /--accent|432bff/i);
  const code = html.slice(html.indexOf("// ---- the reply chime"), html.indexOf("// The caret installs this callback"));
  assert.ok(code.length > 1000, "the chime code was not found");
  assert.equal(code.includes("\u2014"), false, "an em dash is in the chime code");
});

test("the sound is the chosen one: two sine notes, C5 then G5, at 60 percent", async () => {
  const { context, page } = await open();
  try {
    await replies(page, garden);
    const all = await page.evaluate(() => window.__audio.rings());
    assert.equal(all.length, 1);
    const [ring] = all;
    assert.equal(ring.volume, 0.6);
    assert.equal(ring.notes.length, 2);
    const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);
    const when = 12.5 + 0.03;
    [[523.25, 0], [783.99, 0.23]].forEach(([freq, offset], i) => {
      const note = ring.notes[i];
      const start = when + offset;
      assert.equal(note.type, "sine");
      assert.equal(note.freq, freq);
      near(note.start, start, "start");
      near(note.stop, start + 0.66 + 0.03, "stop");
      assert.equal(note.env.length, 4);
      assert.deepEqual(note.env.map(c => [c[0], c[1]]), [["set", 0], ["linear", 0.24], ["exp", 0.0001], ["linear", 0]]);
      near(note.env[0][2], start, "envelope start");
      near(note.env[1][2], start + 0.045, "soft start of 45 ms");
      near(note.env[2][2], start + 0.66, "ring");
      near(note.env[3][2], start + 0.66 + 0.02, "close");
    });
  } finally { await context.close(); }
});

test("nothing rings at first load, however many replies were already waiting", async () => {
  for (const owner of ["facilitator", garden, orchard]) {
    const id = await create(owner);
    await fx.post(`/reply?box=${id}`, "An answer left waiting.");
  }
  const { context, page, problems } = await open();   // armed: the context would play
  try {
    await front(page, false);   // behind: even the project on screen would ring
    assert.equal(await page.evaluate(() => window.__audio.gesture), true);
    await beside(page);
    await beside(page);
    assert.equal(await rings(page), 0, "a card already waiting rang at load");
    // the same page does ring for a reply that lands after it
    await replies(page, orchard);
    assert.equal(await rings(page), 1, "the chime is not wired, so the silence proves nothing");
    assert.deepEqual(problems, []);
  } finally { await context.close(); }
});

test("a burst of replies gives one chime, and the next only after two minutes", async () => {
  const { context, page, problems } = await open();
  try {
    // five replies inside one reading
    await replies(page, garden, 5);
    assert.equal(await rings(page), 1, "five replies at once did not give one chime");

    // and more through the next minute, one reading apiece
    for (let i = 0; i < 3; i++) {
      await replies(page, i % 2 ? orchard : garden);
      await beside(page);
    }
    assert.equal(await rings(page), 1, "replies one by one inside the gap rang again");

    await skew(page, 100 * 1000);
    await replies(page, garden);
    assert.equal(await rings(page), 1, "a reply 100 seconds on rang");

    await skew(page, 130 * 1000);
    await replies(page, garden);
    assert.equal(await rings(page), 2, "a reply after two minutes did not ring");

    // the gap runs from the chime, not from the silent replies before it
    await skew(page, 140 * 1000);
    await replies(page, garden);
    assert.equal(await rings(page), 2, "a reply ten seconds after a chime rang");
    assert.deepEqual(problems, []);
  } finally { await context.close(); }
});

test("the gap is two minutes exactly", async () => {
  const { context, page } = await open();
  try {
    await replies(page, garden);
    assert.equal(await rings(page), 1);
    const last = Number(await page.evaluate(() => localStorage.getItem("chimelast")));
    assert.ok(last > 0, "the chime did not note when it rang");
    const at = ms => page.evaluate((t, ms) => {
      const real = Date.now;
      Date.now = () => t + ms;
      try { chimeRing(); } finally { Date.now = real; }
    }, last, ms);
    await at(2 * MINUTE - 1);
    assert.equal(await rings(page), 1, "one millisecond short of two minutes rang");
    await at(2 * MINUTE);
    assert.equal(await rings(page), 2, "two minutes did not ring");
  } finally { await context.close(); }
});

test("a reply on the project on screen is silent while the window is in front, another project rings", async () => {
  const { context, page, problems } = await open();
  try {
    await replies(page, "facilitator", 2);
    assert.equal(await rings(page), 0, "a reply on the tab in view rang");
    await replies(page, garden);
    assert.equal(await rings(page), 1, "a reply on another project did not ring");

    // the tab changes, so does which one is in view
    await show(page, garden);
    await skew(page, 130 * 1000);
    await replies(page, garden);
    assert.equal(await rings(page), 1, "a reply on the newly shown project rang");
    await replies(page, "facilitator");
    assert.equal(await rings(page), 2, "a reply on the project just left did not ring");

    // home shows no project, so every project rings
    await page.click("#homeico");
    await page.waitForFunction(() => document.body.classList.contains("home"));
    await skew(page, 260 * 1000);
    await replies(page, garden);
    assert.equal(await rings(page), 3, "a reply with home open did not ring");
    assert.deepEqual(problems, []);
  } finally { await context.close(); }
});

test("with the window not in front every project rings, the one on screen too", async () => {
  const { context, page } = await open();
  try {
    await front(page, false);   // not focused
    await replies(page, "facilitator");
    assert.equal(await rings(page), 1, "an unfocused window stayed silent for the project on screen");

    await skew(page, 130 * 1000);
    await front(page, true, false);   // focused but hidden
    await replies(page, "facilitator");
    assert.equal(await rings(page), 2, "a hidden window stayed silent for the project on screen");

    await skew(page, 260 * 1000);
    await front(page, true, true);   // in front again
    await replies(page, "facilitator");
    assert.equal(await rings(page), 2, "the window in front rang for the project on screen");
  } finally { await context.close(); }
});

test("the bell mutes and unmutes: slash, label and state follow, nothing rings while muted", async () => {
  const { context, page, problems } = await open({ viewport: { ...VIEW, deviceScaleFactor: 3 } });
  try {
    const look = () => page.evaluate(() => {
      const b = document.getElementById("chimebtn");
      return { pressed: b.getAttribute("aria-pressed"), title: b.title,
        slash: getComputedStyle(b.querySelector(".chime-slash")).display,
        gap: getComputedStyle(b.querySelector(".chime-gap")).display,
        stored: (globalThis.boardSettings || localStorage).getItem("chimemuted"), label: b.getAttribute("aria-label") };
    });
    const bar = async name => {
      if (!SHOTS) return;
      fs.mkdirSync(SHOTS, { recursive: true });
      await page.mouse.move(5, 500);
      await nap(300);
      await page.screenshot({ path: path.join(SHOTS, name + "-closeup.png"),
        clip: { x: VIEW.width - 260, y: 0, width: 260, height: 50 } });
      await page.screenshot({ path: path.join(SHOTS, name + "-bar.png"),
        clip: { x: 0, y: 0, width: VIEW.width, height: 60 } });
    };

    const on = await look();
    assert.equal(on.pressed, "true");
    assert.equal(on.slash, "none");
    assert.equal(on.stored, null);
    await bar("bell-on");

    await page.click("#chimebtn");
    const off = await look();
    assert.equal(off.pressed, "false");
    assert.equal(off.slash, "inline", "no slash over the bell when muted");
    assert.equal(off.gap, "inline");
    assert.equal(off.stored, "1");
    assert.match(off.title, /muted.*unmute/i);
    assert.equal(off.label, "Reply chime");
    await bar("bell-off");

    await replies(page, garden);
    await replies(page, orchard);
    assert.equal(await rings(page), 0, "a muted board rang");

    await page.focus("#chimebtn");
    await page.keyboard.press("Enter");
    const again = await look();
    assert.equal(again.pressed, "true");
    assert.equal(again.slash, "none", "the slash stayed after unmuting");
    assert.equal(again.stored, null);
    assert.match(again.title, /chime on.*mute/i);

    await replies(page, garden);
    assert.equal(await rings(page), 1, "an unmuted board stayed silent: the mute held back nothing else");
    assert.deepEqual(problems, []);
  } finally { await context.close(); }
});

const settled = page => page.waitForFunction(() => !globalThis.boardSettings || !boardSettings.busy);
const onBoard = async () => (await (await fetch(fx.origin + "/settings")).json()).values.chimemuted;

test("the choice to mute is the board's setting and is kept across a reload, and so is being on", async () => {
  const { context, page, problems } = await open();
  try {
    await page.click("#chimebtn");
    await settled(page);
    assert.equal(await onBoard(), "1", "the mute did not reach the board's settings");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.body.classList.contains("layout-ready") && typeof lastState !== "undefined" && lastState);
    const pressed = () => page.evaluate(() => document.getElementById("chimebtn").getAttribute("aria-pressed"));
    assert.equal(await pressed(), "false", "the bell came back on after a reload");
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector("#chimebtn .chime-slash")).display), "inline");
    await replies(page, garden);
    assert.equal(await rings(page), 0, "a muted board rang after a reload");

    await page.click("#chimebtn");
    await settled(page);
    assert.equal(await onBoard(), undefined, "unmuting did not clear the board's setting");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.body.classList.contains("layout-ready") && typeof lastState !== "undefined" && lastState);
    assert.equal(await pressed(), "true", "the bell stayed muted after being turned on");
    await replies(page, orchard);
    assert.equal(await rings(page), 1);
    assert.deepEqual(problems, []);
  } finally { await context.close(); }
});

test("a window that is not the one clicked takes the new choice within a reading", async () => {
  const first = await open();
  try {
    const second = await first.context.newPage();
    await second.setViewport(VIEW);
    await second.goto(fx.origin + "/", { waitUntil: "domcontentloaded" });
    await second.waitForFunction(() => document.body.classList.contains("layout-ready") && typeof lastState !== "undefined" && lastState);
    await second.click("#chimebtn");
    // the first window is behind now, so the wait asks on a timer, not on frames
    await first.page.waitForFunction(() => document.getElementById("chimebtn").getAttribute("aria-pressed") === "false",
      { timeout: 5000, polling: 200 });
    // the choice is the board's, so it is put back for the tests after this one
    await second.click("#chimebtn");
    await settled(second);
    assert.equal(await onBoard(), undefined);
  } finally { await first.context.close(); }
});

test("without a click the chime is skipped, never queued, and the first click arms the next", async () => {
  const { context, page, problems } = await open({ armed: false });
  try {
    await replies(page, garden);
    assert.equal(await rings(page), 0, "a chime played with no click on the page");
    assert.equal(await page.evaluate(() => localStorage.getItem("chimelast")), null,
      "a chime that could not play was counted as one that rang");

    await touch(page);
    await beside(page);
    await beside(page);
    assert.equal(await rings(page), 0, "the skipped chime was held and played on the first click");
    assert.ok(await page.evaluate(() => window.__audio.resumes) > 0, "the first click did not wake the audio");

    await replies(page, garden);
    assert.equal(await rings(page), 1, "the next reply after the click did not ring at once");
    assert.equal(await page.evaluate(() => window.__audio.made), 1, "more than one audio context was made");
    assert.deepEqual(problems, []);
  } finally { await context.close(); }
});

// headless Chrome counts the page as already clicked, so Chrome's own click rule
// cannot be shown here; the stand-in above holds the page to it. This one shows
// the sound builds and runs on the browser's own audio context
test("a real audio context starts both notes", async () => {
  const { context, page, problems } = await open({ prep: withSpy() });
  try {
    await touch(page);
    await replies(page, garden);
    const seen = await page.evaluate(() => ({ made: window.__spy.made, oscillators: window.__spy.oscillators }));
    assert.equal(seen.made, 1);
    assert.equal(seen.oscillators, 2, "the two notes were not both started");
    await page.waitForFunction(() => window.__spy.ctx.state === "running" && window.__spy.ctx.currentTime > 0.2, { timeout: 5000 });
    assert.deepEqual(problems, []);
  } finally { await context.close(); }
});
