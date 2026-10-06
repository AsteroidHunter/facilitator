// Run the real desktop shortcut guard and existing application handlers through
// capture/target/bubble dispatch. This small DOM models propagation and listener
// registration/removal; the browser companion checks native DOM/CodeMirror.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const read = name => fs.readFileSync(path.join(process.env.PAGE_GUARD_SOURCE_ROOT || path.join(__dirname, ".."), name), "utf8");
const html = process.env.MAC_ZOOM_HTML ? fs.readFileSync(process.env.MAC_ZOOM_HTML, "utf8") : read("index.html");
const logic = read("card-logic.js");
const guard = html.slice(html.indexOf("function chromeShortcutBlocked(e){"), html.indexOf("\n</script>", html.indexOf("function chromeShortcutBlocked(e){")));
assert.ok(guard.includes("installChromeShortcutGuard();"));

const { Node, dispatch } = require("./page-event-model.cjs");
function world({ platform = "MacIntel", userAgentData, board = true } = {}) {
  const window = new Node(null, "window"), document = new Node(window, "document"), body = new Node(document);
  document.body = body; document.activeElement = body;
  const nodes = [window, document, body], timers = new Map(); let next = 1;
  const state = { live: true, unselected: 0, saved: 0, calls: [] };
  const context = vm.createContext({ window, document, navigator: { platform, userAgentData }, Date,
    addEventListener: window.addEventListener.bind(window),
    setTimeout(fn) { const id = next++; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id),
    setInterval() {}, clearInterval() {},
    FOCUS: true, boardKeysLive: () => state.live, boardResponseCard: () => true,
    ownerReady: true, draft: false, activeOwner: "one", selectedId: "c1", lastState: {}, LOCKED: false,
    rowsOf: () => ["one", "two"], unselectShown: () => state.unselected++,
    newCard: owner => state.calls.push(["create", owner]),
    setTab: owner => state.calls.push(["tab", owner]),
    nav: (...args) => state.calls.push(["navigate", ...args]),
    histStep: (...args) => state.calls.push(["history", ...args]),
    fileNavSave: () => state.saved++,
  });
  vm.runInContext(logic, context);
  // The actual desktop dispatch and Escape/create/project actions run before
  // the guard, just as they are installed before it in index.html.
  if (board) {
    const start = html.indexOf("const boardShortcutTyping =");
    const end = html.indexOf("listenResponseScroll();", start) + "listenResponseScroll();".length;
    vm.runInContext(html.slice(start, end), context);
  }
  return { window, document, body, state, context,
    node(parent = body, kind) { const node = new Node(parent, kind); nodes.push(node); return node; },
    install() { vm.runInContext(guard, context); },
    send(target = body, options = {}) { return dispatch(target, options); },
    flush() { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } },
    listenerCount: () => nodes.reduce((n, node) => n + node.listeners.length, 0),
    pending: () => timers.size,
  };
}
const cmd = (key, code, extra) => ({ key, code, ...extra });

// Frame events have their own window at the root of the propagation path.
// Run the shipped phone gate and the host's actual connection callback.
function phoneFrame({ direct = false, platform = "MacIntel", userAgentData } = {}) {
  const host = world({ platform, userAgentData, board: false });
  host.install();
  const window = new Node(null, "window"), document = new Node(window, "document"), body = new Node(document);
  const callback = html.match(/    childConnected\(child\) \{([\s\S]*?)\n    \},/);
  assert.ok(callback, "the Mac host must wire its child on connection");
  host.context.chimeEnsure = () => {};
  const connected = vm.runInContext(`(child) => {${callback[1]}\n}`, host.context);
  const origin = "http://board.test", parent = direct ? window : {
    location: { origin }, macPhoneHost: { accepts: child => child === window, connect: connected },
  };
  const phone = read("m.html"), start = phone.indexOf("const macHost = (() => {"),
    end = phone.indexOf("if (macHost) window.macPhoneInactive = true;", start);
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext({ window, document, parent, URLSearchParams,
    location: { origin, search: "?mac=1" } });
  vm.runInContext(phone.slice(start, end) + "if (macHost) macHost.connect(window);", context);
  return { window, body, send: options => dispatch(body, { type: "wheel", metaKey: false, ...options }) };
}

test("embedded phone on Mac cancels Control wheel but preserves plain wheel and propagation", () => {
  for (const platform of [{ platform: "MacIntel" }, { platform: "", userAgentData: { platform: "macOS" } }]) {
    const f = phoneFrame(platform);
    let reached = 0;
    f.body.addEventListener("wheel", () => reached++);
    for (const deltaY of [-80, 80]) {
      const e = f.send({ ctrlKey: true, deltaY });
      assert.equal(e.defaultPrevented, true);
      assert.equal(e.cancelBubble, false);
      assert.equal(f.send({ ctrlKey: false, deltaY }).defaultPrevented, false);
    }
    assert.equal(reached, 4);
    assert.equal(f.send({ ctrlKey: true, cancelable: false }).defaultPrevented, false);
    const listener = f.window.listeners.find(l => l.type === "wheel");
    assert.equal(listener.capture, true);
    assert.equal(listener.passive, false);
    for (const type of ["gesturestart", "gesturechange"])
      assert.equal(f.send({ type }).defaultPrevented, true);
  }
});

test("a directly opened phone page gains no Mac guards, even with the frame marker", () => {
  for (const platform of ["iPhone", "MacIntel"]) {
    const f = phoneFrame({ direct: true, platform });
    assert.equal(f.window.listeners.length, 0);
    for (const ctrlKey of [false, true])
      assert.equal(f.send({ ctrlKey }).defaultPrevented, false);
  }
});

const BLOCKED = [
  cmd("t", "KeyT"), cmd("T", "KeyT", { shiftKey: true }),
  cmd("Dead", "KeyU", { altKey: true }), cmd("p", "KeyP", { ctrlKey: true }),
  cmd("s", "KeyS"), cmd("p", "KeyP"), cmd("π", "KeyP", { altKey: true }),
  cmd(".", "Period"), cmd("g", "KeyG"), cmd("G", "KeyG", { shiftKey: true }), cmd("e", "KeyE"),
  cmd("=", "Equal"), cmd("+", "Equal", { shiftKey: true }), cmd("-", "Minus"), cmd("0", "Digit0"),
  cmd("[", "BracketLeft"), cmd("]", "BracketRight"), cmd("ArrowLeft", "ArrowLeft"), cmd("ArrowRight", "ArrowRight"),
  cmd("Dead", "KeyI", { altKey: true }), cmd("∆", "KeyJ", { altKey: true }), cmd("ç", "KeyC", { altKey: true }),
  cmd("C", "KeyC", { shiftKey: true }), cmd("F12", "F12", { metaKey: false }), cmd("F7", "F7", { metaKey: false }),
  cmd("n", "KeyN"), cmd("N", "KeyN", { shiftKey: true }), cmd("y", "KeyY"),
  cmd("J", "KeyJ", { shiftKey: true }), cmd("¬", "KeyL", { altKey: true }), cmd("∫", "KeyB", { altKey: true }),
  cmd("Backspace", "Backspace", { shiftKey: true }), cmd(",", "Comma"), cmd("?", "Slash", { shiftKey: true }),
  cmd("Escape", "Escape", { metaKey: false }),
];

test("every requested default is canceled after application handlers on the page", () => {
  const f = world({ board: false }), seen = [];
  f.body.addEventListener("keydown", e => seen.push(e.defaultPrevented));
  f.install();
  const listeners = f.listenerCount();
  for (const key of BLOCKED) {
    const e = f.send(f.body, key);
    assert.equal(e.defaultPrevented, true, JSON.stringify(key));
    assert.equal(e.cancelBubble, false, "the guard swallowed propagation");
    assert.equal(seen.at(-1), false, "an application handler saw early cancellation");
    assert.equal(f.listenerCount(), listeners, "observers were left attached");
    assert.equal(f.pending(), 0);
  }
});

test("real card Escape still unselects and typing Escape still blurs before cancellation", () => {
  const f = world(); f.install();
  assert.equal(f.send(f.body, { key: "Escape", code: "Escape", metaKey: false }).defaultPrevented, true);
  assert.equal(f.state.unselected, 1);
  const textarea = f.node(f.body, "textarea");
  const e = f.send(textarea, { key: "Escape", code: "Escape", metaKey: false });
  assert.equal(textarea.blurs, 1); assert.equal(e.defaultPrevented, true);
  f.send(f.body, { key: "Escape", code: "Escape", metaKey: false, repeat: true });
  assert.equal(f.state.unselected, 1, "a held Escape replayed selection");
});

test("real title handler restores its title/focus, while stopped browser keys still cancel", () => {
  const f = world(), title = f.node(f.body, "title");
  let ended = 0, focused = 0;
  Object.assign(f.context, { t: title, old: "Original", keyboardTitle: true,
    end: () => ended++, commit: () => assert.fail("Escape unexpectedly committed"),
    el: { ta: { focus: () => focused++ } } });
  vm.runInContext("keyboardTitle = true", f.context);
  title.textContent = "Edited";
  const start = logic.indexOf("  t.onkeydown = e => {", logic.indexOf("function editTitle("));
  const end = logic.indexOf("  t.onblur =", start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(logic.slice(start, end), f.context);
  f.install();
  assert.equal(f.send(title).defaultPrevented, true, "title stopPropagation leaked Cmd+S");
  const e = f.send(title, { key: "Escape", code: "Escape", metaKey: false });
  assert.equal(e.defaultPrevented, true); assert.equal(title.textContent, "Original");
  assert.equal(ended, 1); assert.equal(focused, 1);
  assert.equal(f.state.unselected, 0, "title Escape escaped into the board");
});

test("the real settings propagation boundary and inactive board do not leak browser defaults", () => {
  const f = world(), veil = f.node(), input = f.node(veil, "input");
  let closed = 0;
  Object.assign(f.context, { veil, close: () => closed++ });
  const start = logic.indexOf('  veil.addEventListener("keydown", e => {', logic.indexOf("function settingsOverlay("));
  const end = logic.indexOf("  // a press that starts", start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(logic.slice(start, end), f.context);
  f.state.live = false; f.install();
  for (const key of BLOCKED.filter(k => !k.key.startsWith("Arrow")))
    assert.equal(f.send(input, key).defaultPrevented, true, JSON.stringify(key));
  assert.equal(closed, 1);
  assert.equal(f.state.unselected, 0);
  assert.equal(f.send(f.body).defaultPrevented, true, "Home/blank page leaked Cmd+S");
});

test("an asynchronously mounted file editor gets its real Mod-s binding before browser cancellation", () => {
  const f = world(); f.install();
  const editor = f.node(f.body, "editor"), content = f.node(editor, "title");
  const source = html.match(/\{ key: "Mod-s", preventDefault: true, run: \(\) => \{ fileNavSave\(\); return true; \} \}/)?.[0];
  assert.ok(source);
  const binding = vm.runInContext("(" + source + ")", f.context);
  editor.addEventListener("keydown", e => {
    if (e.defaultPrevented || !e.metaKey || e.key !== "s") return;
    const handled = binding.run();
    if (handled || binding.preventDefault) e.preventDefault();
    e.stopPropagation();
  });
  const count = f.listenerCount(), e = f.send(content);
  assert.equal(f.state.saved, 1); assert.equal(e.defaultPrevented, true);
  assert.equal(f.listenerCount(), count); assert.equal(f.pending(), 0);
});

test("app-owned editing actions run before cancellation, including stopped Cmd+G", () => {
  const f = world({ board: false }); f.install();
  const editor = f.node(f.body, "editor"); let edits = 0;
  editor.addEventListener("keydown", e => {
    assert.equal(e.defaultPrevented, false); edits++; e.stopPropagation();
  });
  assert.equal(f.send(editor, cmd("g", "KeyG")).defaultPrevented, true);
  assert.equal(edits, 1);
});

test("Command+arrows remain editable caret movement, including decorated descendants", () => {
  const f = world({ board: false }); f.install();
  for (const kind of ["input", "textarea", "textbox", "title", "editor"]) {
    const parent = f.node(f.body, kind), child = f.node(parent, "span");
    for (const key of ["ArrowLeft", "ArrowRight"])
      assert.equal(f.send(child, cmd(key, key)).defaultPrevented, false, kind);
  }
  assert.equal(f.send(f.body, cmd("ArrowLeft", "ArrowLeft")).defaultPrevented, true);
});

test("Find/reload, ordinary editing, app gaps and native/OS controls retain their default state", () => {
  const f = world({ board: false }); f.install();
  const kept = [cmd("f", "KeyF"), cmd("r", "KeyR"), cmd("R", "KeyR", { shiftKey: true }),
    ...["c", "x", "v", "a", "z", "1", "w", "q", "h", "m", "`"].map(key => ({ key })),
    cmd("Z", "KeyZ", { shiftKey: true }), cmd("V", "KeyV", { shiftKey: true }),
    cmd("W", "KeyW", { shiftKey: true }),
    cmd("h", "KeyH", { altKey: true }), cmd("f", "KeyF", { ctrlKey: true }),
    cmd("ArrowLeft", "ArrowLeft", { shiftKey: true }), cmd("ArrowRight", "ArrowRight", { shiftKey: true }),
    cmd("Backspace", "Backspace"), cmd("Delete", "Delete"),
    cmd("Tab", "Tab"), cmd(" ", "Space", { metaKey: false }),
    cmd("s", "KeyS", { metaKey: false, ctrlKey: true }),
    cmd("r", "KeyR", { metaKey: false, ctrlKey: true }),
  ];
  for (const key of kept) assert.equal(f.send(f.body, key).defaultPrevented, false, JSON.stringify(key));
});

test("the real create/project handlers still run and inactive-board tab defaults are canceled", () => {
  const f = world(); f.install();
  f.send(f.body, cmd("t", "KeyT")); f.send(f.body, cmd("T", "KeyT", { shiftKey: true }));
  f.send(f.body, cmd("2", "Digit2"));
  assert.deepEqual(f.state.calls, [["create", "one"], ["create", "one"], ["tab", "two"]]);
  f.state.live = false;
  assert.equal(f.send(f.body, cmd("t", "KeyT")).defaultPrevented, true);
  assert.equal(f.send(f.body, cmd("T", "KeyT", { shiftKey: true })).defaultPrevented, true);
});

test("capture stops are canceled after their handler, and canceled immediate stops clean up", () => {
  const f = world({ board: false }), target = f.node(); let seen;
  f.document.addEventListener("keydown", e => { seen = e.defaultPrevented; e.stopPropagation(); }, true);
  f.install();
  const count = f.listenerCount();
  assert.equal(f.send(target).defaultPrevented, true); assert.equal(seen, false);
  assert.equal(f.listenerCount(), count);
  const g = world({ board: false }), own = g.node();
  own.addEventListener("keydown", e => { e.preventDefault(); e.stopImmediatePropagation(); });
  g.install(); const kept = g.listenerCount();
  assert.equal(g.send(own).defaultPrevented, true);
  g.flush(); assert.equal(g.listenerCount(), kept); assert.equal(g.pending(), 0);
});

test("a nested key dispatch cannot cancel or remove another event's observers", () => {
  const f = world({ board: false }); let nested;
  f.body.addEventListener("keydown", e => {
    assert.equal(e.defaultPrevented, false);
    if (e.key === "s") nested = f.send(f.body, cmd("p", "KeyP"));
  });
  f.install(); const count = f.listenerCount();
  const outer = f.send();
  assert.equal(outer.defaultPrevented, true); assert.equal(nested.defaultPrevented, true);
  assert.equal(f.listenerCount(), count); assert.equal(f.pending(), 0);
});

test("composition/noncancelable keys are left alone, repeats remain blocked and other platforms are untouched", () => {
  const f = world({ board: false }); f.install();
  assert.equal(f.send(f.body, { isComposing: true }).defaultPrevented, false);
  assert.equal(f.send(f.body, { cancelable: false }).defaultPrevented, false);
  assert.equal(f.send(f.body, { bubbles: false }).defaultPrevented, true);
  assert.equal(f.send(f.body, { repeat: true }).defaultPrevented, true);
  assert.equal(f.send(f.body, { key: "ы", code: "KeyS" }).defaultPrevented, true);
  assert.equal(f.send(f.body, { key: "f", code: "KeyS" }).defaultPrevented, false, "an ASCII layout character lost to its physical code");
  const other = world({ platform: "Linux x86_64", board: false }); other.install();
  assert.equal(other.send().defaultPrevented, false);
  assert.equal(other.send(other.body, { key: "F7", code: "F7", metaKey: false }).defaultPrevented, false);
});

test("zoom guard cancels Control + wheel on the board and in the file editor without stopping propagation", () => {
  const f = world({ board: false }); f.install();
  for (const target of [f.body, f.node(f.body, "editor")]) {
    let reached = 0;
    target.addEventListener("wheel", () => reached++);
    for (const deltaY of [-80, 80]) {
      const e = f.send(target, { type: "wheel", ctrlKey: true, metaKey: false, deltaY });
      assert.equal(e.defaultPrevented, true);
      assert.equal(e.cancelBubble, false);
    }
    assert.equal(reached, 2);
  }
});

test("zoom guard leaves ordinary, sideways, Shift and Command wheel defaults alone", () => {
  const f = world({ board: false }); f.install();
  for (const target of [f.body, f.node(f.body, "editor")]) {
    for (const extra of [{}, { deltaX: 100, deltaY: 0 }, { shiftKey: true }, { metaKey: true }]) {
      const e = f.send(target, { type: "wheel", ctrlKey: false, metaKey: false, deltaY: 80, ...extra });
      assert.equal(e.defaultPrevented, false);
      assert.equal(e.cancelBubble, false);
    }
  }
});

test("zoom guard uses explicit non-passive window capture listeners for both Mac platform signals", () => {
  for (const platform of [{ platform: "MacIntel" }, { platform: "", userAgentData: { platform: "macOS" } }]) {
    const f = world({ ...platform, board: false }); f.install();
    for (const type of ["wheel", "gesturestart", "gesturechange"]) {
      const listeners = f.window.listeners.filter(l => l.type === type);
      assert.equal(listeners.length, 1, type);
      assert.equal(listeners[0].capture, true, type);
      assert.equal(listeners[0].passive, false, type);
    }
    // A target that stops immediately still cannot restore browser zoom.
    f.body.addEventListener("wheel", e => e.stopImmediatePropagation());
    assert.equal(f.send(f.body, { type: "wheel", ctrlKey: true }).defaultPrevented, true);
  }
});

test("zoom guard installs no wheel or gesture listeners on other platforms", () => {
  for (const platform of ["Win32", "Linux x86_64", "iPhone", "iPad", ""]) {
    const f = world({ platform, board: false }); f.install();
    assert.equal(f.window.listeners.length, 0, platform);
    for (const type of ["wheel", "gesturestart", "gesturechange"])
      assert.equal(f.send(f.body, { type, ctrlKey: true }).defaultPrevented, false, platform);
  }
});

test("zoom guard cancels Safari pinch defaults only on start/change and keeps other gestures untouched", () => {
  const f = world({ board: false }); f.install();
  for (const type of ["gesturestart", "gesturechange"]) {
    const e = f.send(f.body, { type, ctrlKey: false });
    assert.equal(e.defaultPrevented, true, type);
    assert.equal(e.cancelBubble, false, type);
  }
  for (const type of ["gestureend", "touchstart", "touchmove", "pointerdown", "scroll"])
    assert.equal(f.send(f.body, { type }).defaultPrevented, false, type);
  assert.equal(f.send(f.body, { type: "wheel", ctrlKey: true, cancelable: false }).defaultPrevented, false);
});

test("zoom guard preserves the real carousel and home chart wheel handlers with Control held", () => {
  const f = world({ board: false }), car = f.node();
  car.scrollLeft = 0;
  f.document.getElementById = id => { assert.equal(id, "carousel"); return car; };
  const start = html.indexOf('  const car = document.getElementById("carousel");');
  const end = html.indexOf('\n}\n', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(html.slice(start, end), f.context);
  const chart = read("home-widgets.js"), chartStart = chart.indexOf("  const LINE_PX ="),
    chartEnd = chart.indexOf("  function grab(", chartStart);
  assert.ok(chartStart >= 0 && chartEnd > chartStart);
  vm.runInContext(chart.slice(chartStart, chartEnd), f.context);
  const lane = f.node(), box = { scrollLeft: 0, clientWidth: 200, contains: target => target === lane };
  lane.querySelector = () => box;
  lane.addEventListener("wheel", e => f.context.wheel(lane, e), { passive: false });
  f.install();
  for (const ctrlKey of [false, true]) {
    const event = { type: "wheel", ctrlKey, metaKey: false, deltaY: 30, deltaX: 0, deltaMode: 0 };
    f.send(car, event); f.send(lane, event);
  }
  assert.equal(car.scrollLeft, 60);
  assert.equal(box.scrollLeft, 60);
});
