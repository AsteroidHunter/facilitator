/*
 * The hover labels of the Mac pages (index.html, onboarding.html and
 * page.html), in place of Chrome's own tooltips. A control names itself in
 * data-tip, in the labels' one format: its name in a word or two, each word
 * capitalised, then its key in brackets when it has one, written the short
 * way with " + " between the keys, as "Home (Cmd + 0)", "Older Reply
 * (Ctrl + Shift + Up)" or just "Search Cards". The control keeps its
 * aria-label for screen readers; the label says the same thing again, so it
 * is kept out of their reach.
 *
 * One label serves the whole page, a single element made the first time it is
 * needed. When the pointer comes to rest on a control for 600ms, or a key
 * brings the focus to one (:focus-visible), the label is filled and placed: a
 * chip of the board's glass above the control, centred on it and kept 8px
 * inside the window, with a small pointer at it, or under it pointing up
 * where there is no room above. It rises 3px into place over 160ms. Once a
 * label has shown, the next control's shows at once, until 450ms after the
 * last one went. Moving off the control, a press, a key or a scroll under it
 * puts it away; a pressed control shows no label again until the pointer has
 * left it. The look is card-tokens.css's (.hl-tip), restated in page.html.
 *
 * The phone page never loads this file: a phone has no pointer to rest.
 */
(function installHoverLabels(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && root.document) {
    root.HoverLabels = api;
    api.install(root);
  }
})(typeof window === "object" ? window : null, function hoverLabelsFactory() {
  "use strict";

  const DELAY = 600;    // ms the pointer rests on a control before its label shows
  const RISE = 160;     // ms of its fade in and its 3px rise (the sheet's --from)
  const WARM = 450;     // ms after a label goes in which the next one shows at once
  const STILL = 4;      // px a pointer may drift and still be resting
  const GAP = 3;        // px between the control and the pointer's tip
  const POINTER = 6;    // px the pointer stands out of the chip
  const INSET = 8;      // px the label keeps from the window's sides
  const EDGE = 4;       // px it keeps from the top and the foot, or takes the other side
  const ROUND = 8;      // px of the chip's corners

  // "Name (Key)" as its two parts; a label with no key in brackets is all name
  function parse(text) {
    const s = String(text == null ? "" : text).trim();
    const m = /^(.*\S)\s+\((.+)\)$/.exec(s);
    return m ? { name: m[1], key: m[2] } : { name: s, key: "" };
  }

  // where a label w wide and h tall, its pointer counted in, stands for a
  // control at rect r in the window view: centred on it and inside the window,
  // above it where it fits and under it where it does not, and above again when
  // neither side has room. px is where the pointer's tip falls along the label
  function place(r, w, h, view) {
    const cx = r.left + r.width / 2;
    const left = Math.round(Math.max(view.left + INSET, Math.min(cx - w / 2, view.right - INSET - w)));
    const at = side => Math.round(side === "below" ? r.bottom + GAP : r.top - GAP - h);
    const fits = top => top >= view.top + EDGE && top + h <= view.bottom - EDGE;
    const side = fits(at("above")) || !fits(at("below")) ? "above" : "below";
    return { left, top: at(side), w, h, side, px: cx - left };
  }

  // the chip and its pointer as one outline, for the glass's clip-path and for
  // the ring and the shadow drawn along it: a chip w by bh with corners of r and
  // a pointer P tall at px, its tip rounded and its foot kept clear of the
  // corners. down puts the pointer under the chip, for a label above its control
  function bubble(w, bh, P, px, down, r) {
    const hw = 6, x = Math.max(r + hw + 1, Math.min(w - r - hw - 1, px));
    const f = n => Math.round(n * 100) / 100;
    if (down) {
      const b = bh;
      return `M${r} 0H${f(w - r)}A${r} ${r} 0 0 1 ${f(w)} ${r}V${f(b - r)}A${r} ${r} 0 0 1 ${f(w - r)} ${f(b)}` +
        `H${f(x + hw)}L${f(x + 1.1)} ${f(b + P - .9)}Q${f(x)} ${f(b + P)} ${f(x - 1.1)} ${f(b + P - .9)}L${f(x - hw)} ${f(b)}` +
        `H${r}A${r} ${r} 0 0 1 0 ${f(b - r)}V${r}A${r} ${r} 0 0 1 ${r} 0Z`;
    }
    const t = P, b = P + bh;
    return `M${r} ${t}H${f(x - hw)}L${f(x - 1.1)} .9Q${f(x)} 0 ${f(x + 1.1)} .9L${f(x + hw)} ${t}` +
      `H${f(w - r)}A${r} ${r} 0 0 1 ${f(w)} ${t + r}V${f(b - r)}A${r} ${r} 0 0 1 ${f(w - r)} ${f(b)}` +
      `H${r}A${r} ${r} 0 0 1 0 ${f(b - r)}V${t + r}A${r} ${r} 0 0 1 ${r} ${t}Z`;
  }

  function install(win) {
    if (win.hoverLabelsInstalled) return;
    win.hoverLabelsInstalled = true;
    const doc = win.document;
    // the label and its parts, made on first use
    let tip = null, glass = null, face = null, uid = 0;
    // cur is the control the label is for, under the pointer (via "pointer")
    // or holding a key's focus (via "focus"); held is a control pressed, which
    // shows no label until the pointer leaves it; rest is where the pointer
    // came to rest, and the wait starts again when it drifts further than STILL
    let cur = null, via = "", held = null, rest = null;
    let timer = 0, shown = false, warmUntil = 0;

    function make() {
      tip = doc.createElement("div");
      tip.className = "hl-tip";
      tip.setAttribute("aria-hidden", "true");
      glass = doc.createElement("div");
      glass.className = "hl-glass qn-glass";
      face = doc.createElement("div");
      face.className = "hl-face";
      tip.append(glass, face);
      doc.body.appendChild(tip);
    }

    // the outline cuts the glass, the ring is drawn on it, and the shadow is
    // drawn under it and masked to fall outside it only
    function shape(p) {
      const path = bubble(p.w, p.h - POINTER, POINTER, p.px, p.side === "above", ROUND);
      tip.style.width = p.w + "px";
      tip.style.height = p.h + "px";
      face.style.top = (p.side === "above" ? 0 : POINTER) + "px";
      glass.style.clipPath = `path("${path}")`;
      for (const s of tip.querySelectorAll("svg")) s.remove();
      const id = "hltip" + (++uid), W = p.w + 80, H = p.h + 80;
      glass.insertAdjacentHTML("beforebegin",
        `<svg class="hl-shade" width="${p.w}" height="${p.h}" aria-hidden="true"><defs>` +
        `<mask id="${id}m" maskUnits="userSpaceOnUse" x="-40" y="-40" width="${W}" height="${H}">` +
        `<rect x="-40" y="-40" width="${W}" height="${H}" fill="#fff"/><path d="${path}" fill="#000"/></mask>` +
        `<filter id="${id}a" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1"/></filter>` +
        `<filter id="${id}b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="7"/></filter></defs>` +
        `<g mask="url(#${id}m)"><path d="${path}" fill="rgba(0,0,0,.16)" filter="url(#${id}a)" transform="translate(0 1)"/>` +
        `<path d="${path}" fill="rgba(0,0,0,.09)" filter="url(#${id}b)" transform="translate(0 7)"/></g></svg>`);
      glass.insertAdjacentHTML("afterend",
        `<svg class="hl-ring" width="${p.w}" height="${p.h}" aria-hidden="true"><path d="${path}" fill="none" stroke="#c7c7cc" stroke-width="1"/></svg>`);
    }

    function show(t, warm) {
      timer = 0;
      if (t !== cur || !t.isConnected) return;
      const { name, key } = parse(t.getAttribute("data-tip"));
      const r = t.getBoundingClientRect();
      if (!name || (!r.width && !r.height)) return;
      if (!tip) make();
      // still while it is filled and moved, so it rises from its new place
      tip.classList.add("hl-still");
      tip.classList.remove("on");
      const n = doc.createElement("span");
      n.className = "hl-name";
      n.textContent = name;
      face.replaceChildren(n);
      if (key) {
        const k = doc.createElement("span");
        k.className = "hl-key";
        k.textContent = "(" + key + ")";
        face.append(" ", k);
      }
      const view = { left: 0, top: 0, right: win.innerWidth, bottom: win.innerHeight };
      const p = place(r, face.offsetWidth, face.offsetHeight + POINTER, view);
      tip.style.left = p.left + "px";
      tip.style.top = p.top + "px";
      tip.classList.toggle("above", p.side === "above");
      tip.classList.toggle("below", p.side === "below");
      shape(p);
      tip.style.setProperty("--in", (warm ? 0 : RISE) + "ms");
      void tip.offsetWidth;
      tip.classList.remove("hl-still");
      tip.classList.add("on");
      shown = true;
    }

    // now takes it away at once rather than fading it
    function hide(now) {
      clearTimeout(timer);
      timer = 0;
      if (!shown) return;
      shown = false;
      warmUntil = performance.now() + WARM;
      tip.classList.toggle("hl-still", !!now);
      tip.classList.remove("on");
    }

    function leave() {
      hide(false);
      cur = null;
      via = "";
    }

    function arm(t) {
      clearTimeout(timer);
      timer = 0;
      if (shown || performance.now() < warmUntil) show(t, true);
      else timer = win.setTimeout(() => show(t, false), DELAY);
    }

    const tipOf = node => (node && node.closest ? node.closest("[data-tip]") : null);

    doc.addEventListener("pointerover", e => {
      if (e.pointerType === "touch") return;
      const t = tipOf(e.target);
      if (t === cur && via === "pointer") return;
      // a label a key brought up stays while the pointer crosses bare page
      if (!t && via === "focus") return;
      if (cur) leave();
      if (!t) return;
      cur = t;
      via = "pointer";
      if (t === held) return;
      rest = { x: e.clientX, y: e.clientY };
      arm(t);
    }, true);

    doc.addEventListener("pointermove", e => {
      if (!cur || via !== "pointer") return;
      if (shown) {
        if (!cur.isConnected) leave();
        return;
      }
      if (!timer || !rest) return;
      if (Math.hypot(e.clientX - rest.x, e.clientY - rest.y) < STILL) return;
      rest = { x: e.clientX, y: e.clientY };
      arm(cur);
    }, { capture: true, passive: true });

    doc.addEventListener("pointerout", e => {
      if (!cur || via !== "pointer") return;
      const to = e.relatedTarget;
      if (to && cur.contains(to)) return;
      if (held === cur) held = null;
      leave();
    }, true);

    doc.addEventListener("pointerdown", () => {
      if (!cur) return;
      held = cur;
      hide(true);
    }, true);

    doc.addEventListener("keydown", () => {
      if (!shown && !timer) return;
      if (via === "pointer") held = cur;
      hide(true);
    }, true);

    doc.addEventListener("focusin", e => {
      const t = e.target;
      if (!t || !t.matches || !t.matches("[data-tip]")) return;
      let keyed = false;
      try { keyed = t.matches(":focus-visible"); } catch (err) {}
      if (!keyed) return;
      if (cur && cur !== t) leave();
      cur = t;
      via = "focus";
      arm(t);
    }, true);

    doc.addEventListener("focusout", e => {
      if (via === "focus" && e.target === cur) leave();
    }, true);

    // a scroll that carries the control away from under its label
    doc.addEventListener("scroll", e => {
      if (!cur || (!shown && !timer)) return;
      const s = e.target;
      if (s !== doc && !(s && s.contains && s.contains(cur))) return;
      if (via === "pointer") held = cur;
      hide(true);
    }, { capture: true, passive: true });

    win.addEventListener("blur", () => { hide(true); cur = null; via = ""; });
    win.addEventListener("resize", () => hide(true));
  }

  return { install, parse, place, bubble, DELAY, RISE, WARM, GAP, POINTER, INSET, EDGE };
});
