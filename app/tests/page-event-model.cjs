// Capture, target and bubble dispatch only. No browser or server.
class Node {
  constructor(parent, kind = "body") {
    this.parent = parent; this.kind = kind; this.listeners = [];
    this.isContentEditable = kind === "title";
    this.blurs = 0;
    Object.defineProperty(this, "onkeydown", { set: fn => {
      if (!this.idl) { this.idl = e => this.keyHandler?.(e); this.addEventListener("keydown", this.idl); }
      this.keyHandler = fn;
    } });
  }
  addEventListener(type, fn, options = false) {
    const capture = options === true || !!options.capture;
    if (!this.listeners.some(l => l.type === type && l.fn === fn && l.capture === capture))
      this.listeners.push({ type, fn, capture, passive: options.passive });
  }
  removeEventListener(type, fn, options = false) {
    const capture = options === true || !!options.capture;
    this.listeners = this.listeners.filter(l => l.type !== type || l.fn !== fn || l.capture !== capture);
  }
  matches() { return ["input", "textarea", "textbox", "editor"].includes(this.kind); }
  closest() {
    for (let n = this; n; n = n.parent) if (n.isContentEditable || n.matches()) return n;
    return null;
  }
  blur() { this.blurs++; }
}
function dispatch(target, over) {
  const path = []; for (let n = target; n; n = n.parent) path.push(n);
  const e = { type: "keydown", key: "s", code: "KeyS", metaKey: true, ctrlKey: false, altKey: false,
    shiftKey: false, repeat: false, isComposing: false, cancelable: true, bubbles: true,
    defaultPrevented: false, cancelBubble: false, immediate: false, target, ...over,
    composedPath: () => path,
    preventDefault() { if (this.cancelable && !this.passive) this.defaultPrevented = true; },
    stopPropagation() { this.cancelBubble = true; },
    stopImmediatePropagation() { this.immediate = this.cancelBubble = true; },
  };
  const invoke = (node, capture, phase) => {
    e.currentTarget = node; e.eventPhase = phase;
    // A phase uses a snapshot, but removal takes effect at once. Additions on
    // a node not reached yet participate when that later phase is entered.
    for (const l of [...node.listeners]) {
      if (e.immediate) break;
      if (l.type === e.type && l.capture === capture && node.listeners.includes(l)) {
        e.passive = l.passive;
        l.fn(e);
        e.passive = false;
      }
    }
  };
  for (const node of [...path].reverse()) {
    if (e.cancelBubble) break;
    invoke(node, true, node === target ? 2 : 1);
  }
  if (!e.cancelBubble) for (const node of path) {
    if (e.cancelBubble || (node !== target && !e.bubbles)) break;
    invoke(node, false, node === target ? 2 : 3);
  }
  e.currentTarget = null; e.eventPhase = 0;
  return e;
}

module.exports = { Node, dispatch };
