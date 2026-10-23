// The first run's intro and the onboarding's way out, with no browser: the
// board's curtain code (index.html, from the startup curtain to the board's
// reading) run in a vm with the page around it replaced by small fakes and the
// clock handed in. A page that loads with the onboarding to show holds the
// startup globe for 0.7 s from its first paint, then fades the globe out over
// 0.8 s and the onboarding's first card in over 0.8 s from half way into it,
// both on the board's --gentle, and starts the startup sound as the cross fade
// begins: the page's own Web Audio where the browser lets it sound, the Mac's
// afplay otherwise, never both, and only while the board says the sound is
// still to come. Any other page keeps the usual curtain. At the onboarding's
// end the globe comes over the last card on the onboarding's .18s ease, the
// frame goes and home opens under it, and after 0.8 s it fades into home over
// 0.6 s on --gentle. The sound kept for the Mac (assets/startup-sound.wav) is
// read back against the page's own notes.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const MAC = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const ONBOARDING = fs.readFileSync(path.join(ROOT, "onboarding.html"), "utf8");
const TOKENS = fs.readFileSync(path.join(ROOT, "card-tokens.css"), "utf8");

// the curtain's code as the page has it
const SECTION = (() => {
  const from = MAC.indexOf("// the startup curtain (#loading, the phone's globe) comes down once the board can");
  const to = MAC.indexOf("// ---- the board's reading, lean", from);
  assert.ok(from > 0 && to > from, "the curtain's code was not found");
  return MAC.slice(from, to);
})();

const GENTLE = "cubic-bezier(.42, .06, .38, 1)";
const flat = s => s.replace(/\s+/g, "");

function element(name){
  const classes = new Set();
  const e = { name, style: {}, anims: [], removed: 0, isConnected: true,
    classList: { add: (...c) => c.forEach(x => classes.add(x)), remove: (...c) => c.forEach(x => classes.delete(x)),
                 contains: c => classes.has(c) },
    get classes(){ return [...classes].sort(); },
    animate(keyframes, options){
      let done;
      const a = { keyframes, options, startTime: null, cancelled: false,
        finished: new Promise(r => { done = r; }), finish(){ done(a); }, cancel(){ a.cancelled = true; } };
      e.anims.push(a);
      return a;
    },
    remove(){ e.removed++; e.isConnected = false; },
    removeAttribute(n){ if (n === "style") e.style = {}; },
  };
  return e;
}

function param(value){
  const p = { value, events: [] };
  for (const m of ["setValueAtTime", "linearRampToValueAtTime", "exponentialRampToValueAtTime"])
    p[m] = (v, t) => p.events.push([m, v, t]);
  return p;
}

// the page around the curtain's code. onboarding: the flag as the page loads;
// sound: the startup sound still to come; audio: the state a new Web Audio
// context comes up in; paint: the first paint's time, or null when the
// browser has not said yet; obstage: the frame got the onboarding
function page({ onboarding = true, sound = true, audio = "suspended", paint = 380, obstage = true } = {}){
  let now = 0;
  const timers = [], frames = [], fetches = [], contexts = [], loads = [], prepended = [], observers = [];
  const curtain = element("loading"), scene = element("scene"), frame = element("onboard");
  curtain.querySelector = sel => sel === ".scene" ? scene : null;
  frame.addEventListener = (type, fn) => { if (type === "load") loads.push(fn); };
  frame.contentDocument = { getElementById: id => id === "obstage" && obstage ? {} : null, fonts: { ready: Promise.resolve() } };
  frame.contentWindow = { requestAnimationFrame: fn => frames.push(fn) };
  const paints = paint == null ? [] : [{ name: "first-paint", startTime: paint }];
  class Context {
    constructor(){ this.state = audio; this.currentTime = 0.5; this.closed = 0; this.nodes = []; this.destination = { destination: true }; contexts.push(this); }
    close(){ this.closed++; this.state = "closed"; return Promise.resolve(); }
    createGain(){ const n = { kind: "gain", gain: param(1), connect: d => { n.to = d; } }; this.nodes.push(n); return n; }
    createOscillator(){
      const n = { kind: "osc", type: null, frequency: param(440), connect: d => { n.to = d; },
                  start: t => { n.started = t; }, stop: t => { n.stopped = t; } };
      this.nodes.push(n);
      return n;
    }
  }
  const context = vm.createContext({
    document: { getElementById: id => id === "loading" ? curtain : null,
                body: { prepend: e => { prepended.push(e); e.isConnected = true; } } },
    ComposeFormat: { settled: () => Promise.resolve() },
    requestAnimationFrame: fn => frames.push(fn),
    setTimeout: (fn, ms) => { timers.push({ fn, at: now + Math.max(0, ms || 0) }); return timers.length; },
    performance: { now: () => now, getEntriesByName: n => paints.filter(p => p.name === n), getEntriesByType: () => paints },
    PerformanceObserver: class { constructor(fn){ observers.push(fn); } observe(){} disconnect(){} },
    fetch: (url, init) => { fetches.push({ url, body: init.body, at: now }); return Promise.resolve({ ok: true }); },
    window: { AudioContext: Context },
    onboard: { frame: onboarding ? frame : null },
    BOARD_ONBOARDING: onboarding || undefined,
    BOARD_STARTUP_SOUND: sound || undefined,
  });
  vm.runInContext(SECTION, context);
  const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)); };
  return {
    curtain, scene, frame, fetches, contexts, prepended, observers, context,
    // what the page's code answers, as plain values of this realm
    run: code => { const v = vm.runInContext(code, context); return v && typeof v === "object" ? JSON.parse(JSON.stringify(v)) : v; },
    get now(){ return now; },
    // the browser draws a frame: what waited on one runs
    draw(){ for (const fn of frames.splice(0)) fn(now); },
    // the clock moves to ms, and what was due by then runs, in order
    async until(ms){
      for (;;){
        const due = timers.filter(t => !t.ran && t.at <= ms).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        now = Math.max(now, due.at);
        due.ran = true;
        due.fn();
        await settle();
      }
      now = ms;
    },
    // the frame's page loads, its fonts come in and it draws
    async load(at){
      now = at;
      for (const fn of loads.splice(0)) fn();
      await settle();
      this.draw(); this.draw();
      await settle();
    },
    settle,
  };
}

test("the numbers are the settled ones: 0.7 s of globe, two 0.8 s fades half over each other, out in 0.18, 0.8 and 0.6 s", () => {
  const h = page({ onboarding: false });
  assert.deepEqual(h.run("[INTRO_GLOBE_MS, INTRO_FADE_MS, INTRO_OVERLAP, LEAVE_COVER_MS, LEAVE_GLOBE_MS, LEAVE_FADE_MS]"),
                   [700, 800, 0.5, 180, 800, 600]);
  // the fades' curve is the board's own --gentle
  assert.equal(h.run("GENTLE"), GENTLE);
  assert.equal(flat(GENTLE), flat(TOKENS.match(/--gentle:([^;]+);/)[1]));
  // from the first paint: the globe fades from 0.7 to 1.5 s and the card from 1.1 to 1.9 s
  assert.deepEqual(h.run("introTimes(0, 300)"), { cross: 700, globe: [700, 1500], card: [1100, 1900] });
  // a card not drawn by then holds the globe until it is
  assert.deepEqual(h.run("introTimes(100, 2000)"), { cross: 2000, globe: [2000, 2800], card: [2400, 3200] });
  // the way out, from the frame's done: covered at 0.18 s, the fade into home from 0.98 to 1.58 s
  assert.deepEqual(h.run("leaveTimes()"), { covered: 180, out: 980, done: 1580 });
});

test("the first run: the globe stands over the frame, then fades out as the card under it fades in, on the page's clock", async () => {
  const h = page();
  // from the page's start: the curtain over the frame, its ground a veil under the globe
  assert.deepEqual(h.curtain.classes, ["intro", "over"]);
  assert.deepEqual(h.frame.classes, ["under"]);
  // the board's first reading drawn meanwhile does not take the curtain down
  h.run("curtainDrawn()");
  await h.settle(); h.draw(); await h.until(100);
  assert.equal(h.curtain.style.opacity, undefined, "the usual curtain fade ran over the intro");
  assert.equal(h.run("introRun.drawn"), true);
  // the card drawn at 0.3 s: both fades set from the first paint (0.38 s), on the browser's own clock
  await h.load(300);
  const [globe] = h.scene.anims, [veil] = h.curtain.anims;
  assert.equal(globe.startTime, 380 + 700);
  assert.equal(veil.startTime, 380 + 700 + 400);
  for (const a of [globe, veil]){
    assert.deepEqual(JSON.parse(JSON.stringify(a.keyframes)), [{ opacity: 1 }, { opacity: 0 }]);
    assert.equal(a.options.duration, 800);
    assert.equal(a.options.easing, GENTLE);
    assert.equal(a.options.fill, "forwards");
  }
  assert.equal(globe.options.pseudoElement, undefined);
  assert.equal(veil.options.pseudoElement, "::before", "the card does not come in from under the veil");
  // the card in: the curtain goes for good and the frame takes its own place again
  await h.until(1900);
  assert.equal(h.curtain.removed, 0, "the curtain went before the card was in");
  veil.finish();
  await h.settle();
  assert.equal(h.curtain.removed, 1);
  assert.deepEqual(h.curtain.classes, []);
  assert.deepEqual(h.frame.classes, []);
  assert.ok(globe.cancelled && veil.cancelled);
  assert.equal(h.run("curtainDown"), true);
  h.run("curtainDrawn()");
  await h.settle(); h.draw(); await h.until(3000);
  assert.equal(h.curtain.style.opacity, undefined, "the usual curtain came back after the intro");
});

test("a first paint the browser reports late is waited for, and one it never reports is taken at the first frame", async () => {
  const late = page({ paint: null });
  await late.load(200);
  assert.equal(late.scene.anims.length, 0, "the cross fade was set before the first paint was known");
  // the browser says the page first painted at 0.25 s
  late.observers[0]({ getEntries: () => [{ name: "first-paint", startTime: 250 }] });
  await late.settle();
  assert.equal(late.scene.anims[0].startTime, 250 + 700);
  // nobody says in a second: the page's first frame, drawn at 0.2 s, is taken
  const never = page({ paint: null });
  await never.load(200);
  await never.until(999);
  assert.equal(never.scene.anims.length, 0);
  await never.until(1000);
  assert.equal(never.scene.anims[0].startTime, 200 + 700);
});

test("the startup sound plays on the Mac as the cross fade begins when the browser keeps the page quiet", async () => {
  const h = page({ audio: "suspended" });
  assert.equal(h.contexts.length, 1, "the page did not ask the browser early");
  await h.load(300);
  await h.until(1079);
  assert.deepEqual(h.fetches, [], "the sound started before the cross fade");
  await h.until(1080);
  assert.deepEqual(h.fetches.map(f => [f.url, f.body, f.at]), [["/startup-sound", "mac", 1080]]);
  // the held context is closed, never resumed, and the page schedules no note of its own
  assert.equal(h.contexts[0].closed, 1);
  assert.equal(h.contexts[0].nodes.length, 0, "the page played too");
  await h.until(5000);
  assert.equal(h.fetches.length, 1);
});

test("the page plays the sound itself when the browser lets it, the startup tune's notes exactly, and tells the board", async () => {
  const h = page({ audio: "running" });
  await h.load(300);
  await h.until(1080);
  assert.deepEqual(h.fetches.map(f => [f.url, f.body]), [["/startup-sound", "page"]]);
  const ctx = h.contexts[0];
  assert.equal(ctx.closed, 0);
  const [out, ...rest] = ctx.nodes;
  assert.equal(out.kind, "gain");
  assert.equal(out.gain.value, 0.6, "not the chime's output level");
  assert.equal(out.to, ctx.destination);
  const oscs = rest.filter(n => n.kind === "osc"), gains = rest.filter(n => n.kind === "gain");
  // C, E, G and B, 0.07 s apart from 0.05 s on, pure sines
  const when = 0.5 + 0.05;
  assert.deepEqual(oscs.map(o => o.frequency.events), [523.25, 659.26, 783.99, 987.77]
    .map((f, i) => [["setValueAtTime", f, when + [0, 0.07, 0.14, 0.21][i]]]));
  oscs.forEach((o, i) => {
    const start = when + [0, 0.07, 0.14, 0.21][i];
    assert.equal(o.type, "sine");
    assert.equal(o.started, start);
    assert.ok(Math.abs(o.stopped - (start + 1.93)) < 1e-9);
    assert.equal(o.to, gains[i]);
    assert.equal(gains[i].to, out);
    // a 0.09 s rise to 0.075, an exponential fall to silence at 1.9 s, and 20 ms more to nothing
    const ev = gains[i].gain.events;
    assert.deepEqual(ev.map(e => e.slice(0, 2)), [["setValueAtTime", 0], ["linearRampToValueAtTime", 0.075],
      ["exponentialRampToValueAtTime", 0.0001], ["linearRampToValueAtTime", 0]]);
    [0, 0.09, 1.9, 1.92].forEach((d, k) => assert.ok(Math.abs(ev[k][2] - (start + d)) < 1e-9));
  });
  // the context is closed once the sound has rung out
  await h.until(1080 + 2430);
  assert.equal(ctx.closed, 1);
});

test("the sound comes once on a board: a page the board says it already came on makes no context and asks nothing", async () => {
  const h = page({ sound: false });
  assert.equal(h.contexts.length, 0);
  await h.load(300);
  await h.until(4000);
  assert.deepEqual(h.fetches, []);
  assert.equal(h.scene.anims.length, 1, "the intro itself did not run");
});

test("a page that loads with no onboarding to show keeps the usual curtain and no sound", async () => {
  const h = page({ onboarding: false });
  assert.deepEqual(h.curtain.classes, []);
  assert.equal(h.contexts.length, 0);
  h.run("curtainDrawn()");
  await h.settle(); h.draw(); await h.until(10);
  assert.equal(h.curtain.style.opacity, "0");
  assert.equal(h.curtain.style.pointerEvents, "none");
  await h.until(300);
  assert.equal(h.curtain.removed, 1);
  assert.equal(h.scene.anims.length + h.curtain.anims.length, 0);
  assert.deepEqual(h.fetches, []);
});

test("a frame that did not get the onboarding gives the curtain back to the board", async () => {
  const h = page({ obstage: false });
  h.run("curtainDrawn()");
  await h.load(300);
  assert.deepEqual(h.curtain.classes, []);
  assert.deepEqual(h.frame.classes, []);
  assert.equal(h.contexts[0].closed, 1);
  h.draw(); await h.until(310);
  assert.equal(h.curtain.style.opacity, "0", "the board's first reading did not take the curtain down");
  await h.until(5000);
  assert.deepEqual(h.fetches, []);
});

test("the way out: the globe comes over the last card, the frame goes and home opens under it, then it fades into home", async () => {
  const h = page({ sound: false });
  await h.load(300);
  h.curtain.anims[0].finish();
  await h.settle();
  const opened = [];
  h.context.open = () => opened.push(h.now);
  h.curtain.style = { opacity: "0", pointerEvents: "none" };
  h.curtain.classList.add("down");
  h.run("leaveOnboarding(open)");
  // the startup's own curtain, first in the body again, whole, over the frame
  assert.deepEqual(h.prepended, [h.curtain]);
  assert.deepEqual(h.curtain.style, {});
  assert.deepEqual(h.curtain.classes, ["over"]);
  assert.deepEqual(h.frame.classes, ["under"]);
  const a = h.curtain.anims.at(-1);
  assert.deepEqual(JSON.parse(JSON.stringify(a.keyframes)), [{ opacity: 0, easing: "ease" }, { opacity: 1, offset: 180 / 1580 },
    { opacity: 1, offset: 980 / 1580, easing: GENTLE }, { opacity: 0 }]);
  assert.deepEqual(JSON.parse(JSON.stringify(a.options)), { duration: 1580, fill: "forwards" });
  await h.until(h.now + 179);
  assert.deepEqual(opened, [], "the frame went before the globe covered it");
  await h.until(h.now + 1);
  assert.equal(opened.length, 1);
  assert.equal(h.curtain.style.pointerEvents, undefined);
  await h.until(h.now + 800);
  assert.equal(h.curtain.style.pointerEvents, "none", "the fade into home would eat the first click");
  a.finish();
  await h.settle();
  assert.equal(h.curtain.isConnected, false);
  assert.deepEqual(h.curtain.classes, []);
  assert.ok(a.cancelled);
  assert.deepEqual(h.fetches, [], "the way out made a sound");
});

test("the frame's done goes through the way out, and the sheet puts the curtain over the frame", () => {
  const gate = MAC.slice(MAC.indexOf("if (globalThis.BOARD_ONBOARDING) openOnboarding();"), MAC.indexOf("\nfunction showOwnerRefusal"));
  assert.match(gate, /leaveOnboarding\(\(\) => \{\s*if \(FOCUS && !LOCKED && !homeOpen\) setHome\(true\);\s*away\(\);\s*\}\);/);
  assert.ok(MAC.includes("#loading.over{z-index:2147483647}"));
  assert.ok(MAC.includes("#onboard.under{z-index:2147483646}"));
  assert.ok(MAC.includes("#loading.intro{background:transparent}"));
  assert.ok(MAC.includes('#loading.intro::before{content:""; position:absolute; inset:0; background:#ffffff}'));
  // the intro is set up as the page loads, after the frame is up
  assert.ok(SECTION.includes("if (globalThis.BOARD_ONBOARDING && onboard.frame && curtain) introBegin(onboard.frame);"));
  assert.ok(MAC.indexOf("const onboard = {") < MAC.indexOf("introBegin(onboard.frame);"));
});

test("in the board's frame the last card stays for the globe to come over; on a page of its own it fades as before", () => {
  assert.ok(ONBOARDING.includes('document.body.classList.add(parent !== window ? "obleft" : "obdone");'));
  assert.ok(ONBOARDING.includes("body.obdone main{opacity:0; pointer-events:none}"));
  assert.ok(ONBOARDING.includes("body.obleft main{pointer-events:none}"));
  const rules = [...ONBOARDING.matchAll(/^[ \t]*([^\n{}\/*]*obleft[^\n{}]*)\{([^}]*)\}/gm)];
  assert.deepEqual(rules.map(r => r[1].trim()), ["body.obleft main"]);
  assert.doesNotMatch(rules[0][2], /opacity|visibility/, "the card fades in the frame");
});

// the WAV's samples against the page's notes: each note's level and phase are
// fitted from the samples (Chrome starts a sine wherever its render puts it),
// and the level must be the code's own and what is left over next to nothing
test("the Mac's copy of the sound is the page's notes rendered: mono 44.1 kHz, 2.14 s, each note at the code's level", () => {
  const buf = fs.readFileSync(path.join(ROOT, "assets", "startup-sound.wav"));
  assert.equal(buf.toString("ascii", 0, 4), "RIFF");
  assert.equal(buf.toString("ascii", 8, 16), "WAVEfmt ");
  assert.deepEqual([buf.readUInt16LE(20), buf.readUInt16LE(22), buf.readUInt32LE(24), buf.readUInt16LE(34)], [1, 1, 44100, 16]);
  assert.equal(buf.toString("ascii", 36, 40), "data");
  const rate = 44100, n = buf.readUInt32LE(40) / 2;
  assert.equal(n, Math.ceil((2.13 + 0.01) * rate), "not the whole sound to its last stop");
  const sample = i => buf.readInt16LE(44 + i * 2) / 32767;
  const env = tau => tau < 0 ? 0 : tau < 0.09 ? 0.075 * tau / 0.09 : tau < 1.9 ? 0.075 * Math.pow(0.0001 / 0.075, (tau - 0.09) / 1.81)
    : tau < 1.92 ? 0.0001 * (1 - (tau - 1.9) / 0.02) : 0;
  const notes = [[523.25, 0], [659.26, 0.07], [783.99, 0.14], [987.77, 0.21]], fitted = [];
  const others = (t, upto) => fitted.slice(0, upto).reduce((v, p) => v + 0.6 * p.level * env(t - p.s) * Math.sin(2 * Math.PI * p.f * (t - p.s) + p.phase), 0);
  for (const [f, s] of notes){
    let aa = 0, bb = 0, ab = 0, ra = 0, rb = 0;
    for (let i = Math.round(s * rate) + 1; i < Math.round((s + 0.065) * rate); i++){
      const t = i / rate, r = sample(i) - others(t, fitted.length), e = 0.6 * env(t - s);
      const a = e * Math.sin(2 * Math.PI * f * (t - s)), b = e * Math.cos(2 * Math.PI * f * (t - s));
      aa += a * a; bb += b * b; ab += a * b; ra += r * a; rb += r * b;
    }
    const det = aa * bb - ab * ab, A = (ra * bb - rb * ab) / det, B = (rb * aa - ra * ab) / det;
    fitted.push({ f, s, level: Math.hypot(A, B), phase: Math.atan2(B, A) });
  }
  for (const p of fitted) assert.ok(Math.abs(p.level - 1) < 0.002, p.f + " Hz at " + p.level + " of the code's level");
  let worst = 0;
  for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(sample(i) - others(i / rate, 4)));
  assert.ok(worst < 0.001, "the samples are not those notes: " + worst + " left over");
  assert.equal(sample(n - 1), 0, "it does not end in silence");
});
