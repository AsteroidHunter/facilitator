// The card's shared logic: what the desktop board (index.html) and the phone
// page (m.html) do to a card in common, kept once, as plain global functions.
// Each page loads it after card-markdown.js and before its own script. The
// functions here read the names each page declares itself: els (box id to the
// card's parts), lastState, selectedId, activeOwner, lastSel, and the page's own
// poll, select, boxBand and boxHasSelection. The chosen list view is the other way round: it is
// held here, one per project, and each page reads it through curView(). Nothing
// here runs on load.

// ---- what a page may set ----------------------------------------------------
// poolScope: a page that narrows the lane's pool further hands back the test to
// keep a card by, or null for the whole lane. the desktop narrows to the chosen
// workspace; the phone shows the lane whole
let poolScope = null;
// keyPanels: the parts of a page that stand beside the card with work of their
// own, as a selector. a button focused in one keeps the card's control+s, as
// their fields do, where a button anywhere else counts as the page. the desktop
// names its boxes beside the card; the phone has none
let keyPanels = null;
// keyboardTitle: the desktop's keyboard path through a card's title. Tab commits
// the name and moves on to the composer, shift Tab commits it and moves on to the
// card itself (cardStop), and Escape hands focus back to the composer. the phone
// makes the Tab move out of the title in its own listener, and walks the rest of
// the card with cardTab
let keyboardTitle = false;
// cardAnswerOff: where a card's response stands while it is not on the card, for
// control+option+up and down (cardPlace): a function of the card's id answering
// {holds(node), go()}, or null while it is on the card. the desktop's is the
// response piped out beside a long reply; the phone has none
let cardAnswerOff = null;
// answeredRoomChanged: what a page does once the panel that stands ABOVE the
// answer, holding the messages that answer was given, has taken its room or
// given it back. it rides at the head of the answer's own scroller rather than
// being laid over the answer, so the room it takes is room the answer does not
// have, and the desktop re-snaps its lines against it whenever the panel
// arrives, leaves, or is opened or cut back. the panel of sent messages at the
// foot is told per card instead (el.sentRoom), since its room is a measure
// each card keeps for itself
let answeredRoomChanged = null;
// turnAgain: how a page draws its cards again from the board, once a new answer
// it held back while the reader was busy can be shown. the desktop asks the
// board; the phone draws the reading it already holds
let turnAgain = null;
// waitNewestFirst: whether the cards awaiting the reader are listed newest turn
// first. a page answers from the board's waitnewest setting ("1" is newest
// first); until it does, and wherever it is not set, they are listed oldest
// turn first
let waitNewestFirst = () => false;

// Browser defaults shared by the Mac board and the phone document. Install in
// the head, before fields, drawers or other handlers can stop an event.
function cardCommandKey(e){
  // Option uses the physical key; other layouts keep an ASCII character,
  // falling back to the physical key for non-ASCII or unidentified letters.
  const raw = (e.key || "").toLowerCase();
  const physical = /^Key[A-Z]$/.test(e.code || "") ? e.code.slice(3).toLowerCase() :
    ({ Equal: "=", Minus: "-", Digit0: "0", BracketLeft: "[", BracketRight: "]",
       Period: ".", Comma: ",", Slash: "/", Backspace: "backspace" })[e.code];
  return physical && (e.altKey || raw === "dead" || raw === "unidentified" ||
    !raw || (raw.length === 1 && !/[\x20-\x7e]/.test(raw))) ? physical : raw;
}
function cardCreateShortcut(e){
  return e.metaKey && !e.ctrlKey && !e.altKey && cardCommandKey(e) === "t";
}
function installCardPageGuard(win = window){
  if (win.cardPageGuardInstalled) return;
  win.cardPageGuardInstalled = true;
  const doc = win.document;
  const mac = (/^Mac/.test(win.navigator.platform) || win.navigator.userAgentData?.platform === "macOS") &&
    !win.navigator.maxTouchPoints;
  doc.documentElement.classList.add("app-link-policy");
  win.addEventListener("keydown", e => {
    const key = cardCommandKey(e);
    // These commands have no editing default to preserve. Keep propagation:
    // the existing create action still runs in the states that allow it.
    if (cardCreateShortcut(e) || (mac && e.metaKey && !e.shiftKey &&
        ((e.altKey && !e.ctrlKey && key === "u") || (e.ctrlKey && !e.altKey && key === "p"))))
      e.preventDefault();
  }, true);
  // while a card's picture is open the keys are its own: Escape puts it back,
  // and nothing goes on to the board it covers
  win.addEventListener("keydown", e => {
    if (!cardPictureShown) return;
    e.stopImmediatePropagation();
    if (!e.metaKey) e.preventDefault();
    if (e.key === "Escape") closeCardPicture();
  }, true);
  // while the board's folder picker is open the keys are its own too, and the
  // page's wait until it closes (folder-picker.js, which stops each one)
  win.folderPickerKeys = true;
  win.addEventListener("keydown", e => {
    if (win.FolderPicker && win.FolderPicker.isOpen()) win.FolderPicker.key(e);
  }, true);

  let menu = null, returnTo = null;
  const downloads = new WeakSet();
  // click a link this page made itself, with a download name, past the guard
  // below. Only an anchor handed to this function gets by; a link in a card
  // never can, since the set is not reachable from the page's content
  function clickDownload(anchor){
    downloads.add(anchor); doc.body.appendChild(anchor);
    anchor.click(); anchor.remove(); downloads.delete(anchor);
  }
  win.clickDownload = clickDownload;
  function close(restore = false){
    menu?.remove(); menu = null;
    if (restore && returnTo?.isConnected) returnTo.focus({ preventScroll: true });
  }
  function linkFor(e){
    const target = e.target?.nodeType === 3 ? e.target.parentElement : e.target;
    return target?.closest?.("a[href], .cardmd img[src]") ||
      (["contextmenu", "dragstart"].includes(e.type) ? target?.closest?.(".cardmd video[src], .cardmd audio[src]") : null);
  }
  function show(link, e){
    close();
    returnTo = doc.activeElement;
    const raw = link.getAttribute("href") ?? link.getAttribute("src");
    let url;
    try {
      url = new URL(raw, doc.baseURI);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) url = null;
    } catch (_) {}
    menu = doc.createElement("div");
    const shown = menu;
    shown.className = "app-link-menu"; shown.tabIndex = -1;
    shown.setAttribute("role", "menu");
    shown.setAttribute("aria-label", "Link actions");
    const status = doc.createElement("div");
    status.className = "app-link-status";
    status.setAttribute("role", "status");
    const item = (label, action) => {
      const button = doc.createElement("button");
      button.type = "button"; button.textContent = label;
      button.setAttribute("role", "menuitem");
      button.disabled = !url;
      button.addEventListener("click", async event => {
        event.preventDefault(); event.stopPropagation();
        if (button.disabled) return;
        button.disabled = true;
        try { await action(); if (menu === shown) close(true); }
        catch (error) { status.textContent = error.message || "Could not open this link."; }
        finally { button.disabled = false; }
      });
      shown.appendChild(button);
    };
    item("Copy link", async () => {
      try { await win.navigator.clipboard.writeText(url.href); }
      catch (_) { throw new Error("Could not copy the link. Please try again."); }
    });
    item("Open in browser", async () => {
      if (mac && ["localhost", "127.0.0.1"].includes(win.location.hostname)) {
        const response = await win.fetch("/open-in-browser", { method: "POST", body: url.href });
        if (!response.ok) {
          const result = await response.json().catch(() => null);
          throw new Error(result?.error || "Could not open the browser. Try Copy link.");
        }
      } else {
        // An explicit phone action, still inside the button's user activation.
        // iOS chooses the external browser presentation; never replace the app.
        win.open(url.href, "_blank", "noopener,noreferrer");
      }
    });
    if (url && link.hasAttribute("download") && url.origin === win.location.origin && url.pathname.startsWith("/uploads/")) {
      item("Download", () => {
        const anchor = doc.createElement("a");
        anchor.href = url.href; anchor.download = link.getAttribute("download") || "";
        clickDownload(anchor);
      });
    }
    if (!url) status.textContent = "This link is not a web address.";
    shown.appendChild(status); doc.body.appendChild(shown);
    cardTopLayer(shown, link);
    const rect = link.getBoundingClientRect();
    const x = e.clientX || rect.left, y = e.clientY || rect.bottom;
    shown.style.left = Math.max(8, Math.min(x, win.innerWidth - shown.offsetWidth - 8)) + "px";
    shown.style.top = Math.max(8, Math.min(y, win.innerHeight - shown.offsetHeight - 8)) + "px";
    (shown.querySelector("button:not(:disabled)") || shown).focus({ preventScroll: true });
  }
  // a plain click or tap on a card's picture opens it full screen. a modified
  // click, a right click, a drag and a finger held still on it bring the menu,
  // and so does a click on a picture that has not drawn, which has nothing to
  // open. a phone has no right click and iOS sends no contextmenu for a long
  // press, so the held finger is timed here, and the click its lifting may
  // still send is swallowed
  let pressedFrom = null, hold = null, held = null, pressedBox = null;
  const plainClick = e => e.type === "click" && !e.button && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
  function activate(e){
    const link = linkFor(e);
    if (!link){
      // the picture an image box shows has no menu: a plain click expands the
      // box once it is selected, and any other press is left as it was. so is
      // every press on the picture of a box already expanded, where it zooms
      // (magicView)
      const shown = plainClick(e) ? boxImage(e.target) : null;
      if (!shown || !boxSelected(shown) || shown.closest(".magicbox.big")) return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (!magicBoxPicture(shown, pressedFrom)) openCardPicture(shown, null);
      return;
    }
    if (downloads.has(link)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (held === link && e.type === "click"){ held = null; return; }
    if (plainClick(e) && cardPicture(link)){
      // the click that selects a markdown box is only that: no box expanded, no menu
      if (!boxSelected(link)) return;
      // a picture in a magic box expands the box to show it alone; one that
      // cannot leaves the focus where the click in the box put it
      const box = link.closest(".magicbox");
      if (box && magicBoxPicture(link, pressedFrom)) return;
      if (openCardPicture(link, box ? null : pressedFrom)) return;
    }
    show(link, e);
  }
  // the Mac board's box is selected (held) by a press in it, which the board
  // takes after this guard has heard it, so the press records what the box was
  // as it came down: the first click on a picture is the box being selected, the
  // next one expands it. the phone's box has no selected state, so a tap on its
  // pictures expands it at once, as a card's opens on the first tap. a click
  // with no press before it (the keys, a script) reads the box as it stands
  function boxSelected(picture){
    const box = picture.closest(".magicbox"), press = pressedBox;
    pressedBox = null;
    if (!box || box.id !== "magicbox") return true;
    return press?.box === box ? press.held : box.classList.contains("held");
  }
  for (const type of ["click", "auxclick", "contextmenu", "dragstart"])
    win.addEventListener(type, activate, true);
  win.addEventListener("mousedown", e => {
    if (e.button === 1 && linkFor(e)) e.preventDefault();
  }, true);
  win.addEventListener("pointerdown", e => {
    if (menu && !menu.contains(e.target)) close();
    pressedFrom = doc.activeElement;
    const box = e.target?.closest?.(".magicbox");
    pressedBox = box ? { box, held: box.classList.contains("held") } : null;
  }, true);
  const letGo = () => { clearTimeout(hold?.timer); hold = null; };
  win.addEventListener("touchstart", e => {
    letGo(); held = null;
    const target = e.target?.nodeType === 3 ? e.target.parentElement : e.target;
    const picture = e.touches.length === 1 && !cardPictureShown ? cardPicture(target) : null;
    if (!picture) return;
    const at = { clientX: e.touches[0].clientX, clientY: e.touches[0].clientY };
    hold = { at, timer: setTimeout(() => { hold = null; held = picture; show(picture, at); }, CARD_PICTURE_HOLD_MS) };
  }, { capture: true, passive: true });
  win.addEventListener("touchmove", e => {
    const t = e.touches[0];
    if (hold && t && Math.hypot(t.clientX - hold.at.clientX, t.clientY - hold.at.clientY) > CARD_PICTURE_SLOP) letGo();
  }, { capture: true, passive: true });
  for (const type of ["touchend", "touchcancel"]) win.addEventListener(type, letGo, { capture: true, passive: true });
  win.addEventListener("keydown", e => {
    if (menu && menu.contains(e.target)) {
      e.stopImmediatePropagation();
      if (e.key === "Escape") { e.preventDefault(); close(true); }
      else if (["Tab", "ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
        e.preventDefault();
        const items = [...menu.querySelectorAll("button:not(:disabled)")];
        const at = items.indexOf(doc.activeElement);
        const step = e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey) ? -1 : 1;
        const to = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (at + step + items.length) % items.length;
        items[to]?.focus();
      }
      // Enter/Space's native button click remains available.
      return;
    }
    if (e.key === "Enter" && !e.isComposing && linkFor(e)) activate(e);
  }, true);
  win.addEventListener("blur", () => close());

  // File handlers still receive canceled events and do their own uploads.
  // Text drops into writable fields keep their native/editor insertion. All
  // other targets lose the navigation default, even if they stop propagation.
  for (const type of ["dragover", "drop"]){
    win.addEventListener(type, e => {
      const target = e.target?.nodeType === 3 ? e.target.parentElement : e.target;
      const field = target?.closest?.("textarea, input:not([type]), input[type='text'], input[type='search'], input[type='url'], input[type='email'], input[type='tel'], input[type='password'], input[type='number']") ||
        (target?.isContentEditable ? target : null) ||
        target?.closest?.(".cm-editor")?.querySelector(".cm-content[contenteditable='true']");
      const files = [...(e.dataTransfer?.types || [])].includes("Files") || e.dataTransfer?.files?.length;
      if (files || !field || field.disabled || field.readOnly) e.preventDefault();
    }, true);
  }
}

// ---- a card's picture, opened full screen ---------------------------------------
// a picture in a card, in its reply or in the messages sent and answered, opens
// on a plain click or tap as large as its room holds (#picfull .picfull-room in
// card-tokens.css: the settings window's place on the desktop, the whole screen
// inside its safe areas on the phone), centred over the board dimmed. it looks
// and moves as the picture panel's zoom on the desktop board does (p3Zoom): the
// veil is the board's ink at .62, and the picture grows out of its place and
// shrinks back into it over 300ms on the curve the tabs glide on. what grows is
// a copy laid over the board, with the card's own picture hidden where it
// stands, so nothing in the card moves: its scroll, its fold and its layout are
// as they were when the copy lands back on it.
// open, it zooms: two fingers or a trackpad pinch (a wheel with ctrlKey, as
// Chrome sends it) zoom about the pinch, from its fitted size to four times
// that; zoomed, one finger, a dragged mouse or a two-finger scroll moves it,
// never so far that an edge comes in past the room's; a double tap or double
// click goes from fitted to twice at that point and back. at its fitted size a
// tap or a click puts it back, once the moment for a second tap has passed;
// zoomed, it takes Escape. the picture a card's magic box shows (an image box)
// and the pictures in a markdown box are not opened here: the click expands
// the box itself, where the picture zooms and moves the same way
// (magicBoxPicture, magicView), on both pages. on the Mac board that is once
// the box is selected: the click that selects it does not expand it. where the
// box cannot expand (a phone browser without the top layer) its picture opens
// here as before. a page an agent made in the box has its own pictures, which
// are its own; the other boxes beside the card keep the menu for theirs
const CARD_PICTURES = ".reply.cardmd img.shot, .answmsg.cardmd img.shot, .magicbox .mbtext.cardmd img.shot";
const BOX_PICTURE = ".magicbox .mbimg";
const CARD_PICTURE_MS = 300;
const CARD_PICTURE_EASE = "cubic-bezier(0.25, 1, 0.5, 1)";
const CARD_PICTURE_VEIL = 0.62;
// never fitted at more than twice the picture's own size: a small picture still
// comes up large enough to read, and none is blown up to where its pixels show
const CARD_PICTURE_MOST = 2;
// zoomed no further than four times its fitted size; a double tap takes it to twice
const CARD_PICTURE_ZOOM_MOST = 4;
const CARD_PICTURE_ZOOM_TAP = 2;
// a second tap this soon after the first, and this near it, is a double tap
const CARD_PICTURE_DOUBLE_MS = 300;
const CARD_PICTURE_DOUBLE_SLOP = 40;
// a trackpad pinch's wheel zooms by e^(-deltaY / 100); one wheel event counts
// for no more than 60 of that, so a mouse wheel with control held does not leap
const CARD_PICTURE_WHEEL_ZOOM = 0.01;
const CARD_PICTURE_WHEEL_MOST = 60;
// once it has landed on the card's picture, the copy fades off it this fast
const CARD_PICTURE_SETTLE_MS = 120;
// a finger held this long, moving no further than the slop, is a long press
const CARD_PICTURE_HOLD_MS = 500;
const CARD_PICTURE_SLOP = 10;
let cardPictureShown = null;   // what is open, and null whenever nothing is

function cardPicture(target){
  const picture = target?.closest?.(CARD_PICTURES);
  // the stubs beside the card (#magic1 to #magic4) keep the menu; the card's
  // magic box (#magicbox here, #mbface on the phone) is not one of them
  const stub = picture?.closest('[id^="magic"]');
  return picture && (!stub || stub.classList.contains("magicbox")) ? picture : null;
}
// the picture an image box shows, or null
function boxImage(target){
  return target?.closest?.(BOX_PICTURE) || null;
}
// a picture in a card's magic box, clicked or tapped open: the box expands to
// show it, where it zooms (its view's picture, magicView). back: what had
// focus before the press, which has it again as the box goes back. false for
// a picture that has not drawn, or a box that cannot expand
function magicBoxPicture(img, back){
  const view = img.closest(".magicbox")?._view;
  return !!view && !!img.complete && !!img.naturalWidth && view.picture(img, back);
}
// where a picture w by h stands in the box: as large as it fits at its own
// shape, never past CARD_PICTURE_MOST times its size, and centred
function cardPictureFit(w, h, box){
  const s = Math.min(box.w / w, box.h / h, CARD_PICTURE_MOST);
  return { x: box.x + (box.w - w * s) / 2, y: box.y + (box.h - h * s) / 2, w: w * s, h: h * s };
}
// the room it may fill, measured where the sheet lays it out, at this window's size
function cardPictureBox(layer){
  const r = layer.querySelector(".picfull-room").getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}
function cardPicturePlace(big, r){
  Object.assign(big.style, { left: r.x + "px", top: r.y + "px", width: r.w + "px", height: r.h + "px" });
}
// the card's picture where it stands, or null where it stands nowhere
function cardPictureRect(img){
  const r = img.isConnected ? img.getBoundingClientRect() : null;
  return r && r.width && r.height ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
}
// the part of the card's picture the card shows: its box cut by every box
// around it that clips (the answer's scroller, a folded bubble, the card) and by
// the window, or null where none of it shows. it is all the copy may cover as
// it leaves the card and comes back: past it stand the card's title, its head
// and its bubbles, drawn over the picture's hidden part
function cardPictureSeen(img){
  const home = cardPictureRect(img);
  if (!home) return null;
  const win = img.ownerDocument.defaultView;
  let l = home.x, t = home.y, r = home.x + home.w, b = home.y + home.h;
  for (let n = img.parentElement; n && n !== img.ownerDocument.body; n = n.parentElement){
    const cs = win.getComputedStyle(n);
    if (cs.overflowX === "visible" && cs.overflowY === "visible") continue;
    const c = n.getBoundingClientRect();
    l = Math.max(l, c.left); t = Math.max(t, c.top); r = Math.min(r, c.right); b = Math.min(b, c.bottom);
  }
  l = Math.max(l, 0); t = Math.max(t, 0); r = Math.min(r, win.innerWidth); b = Math.min(b, win.innerHeight);
  return r - l > 0.5 && b - t > 0.5 ? { x: l, y: t, w: r - l, h: b - t } : null;
}
// the clip that, on the copy placed at `at` and laid over `home`, leaves only
// `seen` showing, in the copy's own pixels before its transform
function cardPictureClip(seen, home, at){
  const sx = at.w / home.w, sy = at.h / home.h;
  return "inset(" + [(seen.y - home.y) * sy, (home.x + home.w - seen.x - seen.w) * sx,
    (home.y + home.h - seen.y - seen.h) * sy, (seen.x - home.x) * sx].map(v => Math.max(0, v) + "px").join(" ") + ")";
}
const CARD_PICTURE_WHOLE = "inset(0px 0px 0px 0px)";
// the transform that lays the copy, placed at `to`, over `from`
function cardPictureOver(from, to){
  return "translate(" + (from.x - to.x) + "px, " + (from.y - to.y) + "px) scale(" +
    (from.w / to.w) + ", " + (from.h / to.h) + ")";
}
const cardPictureStill = win => !!win.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
// the share of CARD_PICTURE_MS a motion takes that sets off back from where
// `going`, a motion still on its way, has got to: the time it had spent
// getting there, and never under .4 of the whole. one with nothing on its way
// takes the whole time. the magic box turns round the same way (index.html,
// m.html)
function cardPictureTurn(going){
  return going && going.playState === "running" ? Math.min(1, Math.max(0.4, (going.currentTime || 0) / CARD_PICTURE_MS)) : 1;
}
const cardPictureZoomed = z => z.at.w > z.to.w + 0.5;
// the copy at r, kept in the room: across and down, a picture smaller than the
// room stands centred in it, and a larger one never brings an edge in past the
// room's
function cardPictureHeld(z, r){
  const box = cardPictureBox(z.layer);
  const axis = (p, size, start, room) => size <= room ? start + (room - size) / 2
    : Math.min(start, Math.max(start + room - size, p));
  return { x: axis(r.x, r.w, box.x, box.w), y: axis(r.y, r.h, box.y, box.h), w: r.w, h: r.h };
}
// the motion of the moment run out at once, so a gesture starts from where the
// copy stands
function cardPictureSettle(z){
  if (!z.grow) return;
  z.grow.finish(); z.grow.cancel(); z.grow = null;
  z.dim.finish();
}
// the copy at r, there at once or, with `glide`, carried there from where it was
function cardPictureMove(z, r, glide){
  const was = z.at;
  z.at = cardPictureHeld(z, r);
  cardPicturePlace(z.big, z.at);
  if (!glide) return;
  const win = z.layer.ownerDocument.defaultView;
  z.grow = z.big.animate([{ transform: cardPictureOver(was, z.at) }, { transform: "none" }],
    { duration: cardPictureStill(win) ? 0 : CARD_PICTURE_MS, easing: CARD_PICTURE_EASE });
}
// zoomed to s times its fitted size, the picture's point under (x, y) kept there
function cardPictureZoom(z, s, x, y, glide){
  const w = z.to.w * Math.min(CARD_PICTURE_ZOOM_MOST, Math.max(1, s)), k = w / z.at.w;
  cardPictureMove(z, { x: x - (x - z.at.x) * k, y: y - (y - z.at.y) * k, w, h: z.to.h * w / z.to.w }, glide);
}
// a tap or a click on the open picture. the second of two close together takes
// it from fitted to twice its size at that point, or back from any zoom; a lone
// one at its fitted size puts it back once the moment for a second has passed,
// and a lone one while it is zoomed does nothing
function cardPictureTap(z, x, y){
  const prior = z.tapped;
  z.tapped = null;
  if (prior && Date.now() - prior.t < CARD_PICTURE_DOUBLE_MS &&
      Math.hypot(x - prior.x, y - prior.y) < CARD_PICTURE_DOUBLE_SLOP){
    clearTimeout(prior.timer);
    cardPictureSettle(z);
    if (cardPictureZoomed(z)) cardPictureMove(z, z.to, true);
    else cardPictureZoom(z, CARD_PICTURE_ZOOM_TAP, x, y, true);
    return;
  }
  const tapped = z.tapped = { t: Date.now(), x, y, timer: null };
  if (!cardPictureZoomed(z)) tapped.timer = setTimeout(() => {
    if (z.tapped === tapped) z.tapped = null;
    closeCardPicture();
  }, CARD_PICTURE_DOUBLE_MS);
}

// the layer, built the first time a picture is opened and kept afterwards. no
// press on it reaches the board under it: not a tap that would pick or swipe a
// card, not a scroll, not a menu. it reads them itself: touches for the
// fingers, the mouse's drag and click, and the wheel
function cardPictureLayer(doc){
  let layer = doc.getElementById("picfull");
  if (layer) return layer;
  layer = doc.createElement("div");
  layer.id = "picfull";
  const veil = doc.createElement("div");
  veil.className = "picfull-veil";
  const room = doc.createElement("div");
  room.className = "picfull-room";
  layer.append(veil, room);
  const on = (type, fn) => layer.addEventListener(type, e => {
    e.stopPropagation();
    if (type !== "pointerdown" && type !== "mousedown") e.preventDefault();
    const z = cardPictureShown;
    if (z && !z.closing) fn(e, z);
  }, { passive: false });
  const points = e => [...e.touches].map(t => ({ x: t.clientX, y: t.clientY }));
  const middle = p => ({ x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 });
  // the fingers: two pinch about their middle, which carries the picture with
  // it; one moves a zoomed picture, and one put down and lifted without moving,
  // with no second joining it, is a tap. the touches are cancelled, so no click
  // follows them and a tap counts once
  on("touchstart", (e, z) => {
    cardPictureSettle(z);
    const p = points(e);
    if (p.length >= 2)
      z.touch = { pinch: true, spread: Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y) || 1, mid: middle(p), from: z.at };
    else if (p.length === 1)
      z.touch = { pinch: false, start: p[0], last: p[0], tap: !z.touch };
  });
  on("touchmove", (e, z) => {
    const p = points(e), g = z.touch;
    if (!g) return;
    if (g.pinch && p.length >= 2){
      const mid = middle(p);
      const s = g.from.w / z.to.w * Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y) / g.spread;
      const w = z.to.w * Math.min(CARD_PICTURE_ZOOM_MOST, Math.max(1, s)), k = w / g.from.w;
      cardPictureMove(z, { x: mid.x - (g.mid.x - g.from.x) * k, y: mid.y - (g.mid.y - g.from.y) * k, w, h: z.to.h * w / z.to.w });
    } else if (!g.pinch && p.length === 1){
      if (Math.hypot(p[0].x - g.start.x, p[0].y - g.start.y) > CARD_PICTURE_SLOP) g.tap = false;
      if (!g.tap && cardPictureZoomed(z)) cardPictureMove(z, { ...z.at, x: z.at.x + p[0].x - g.last.x, y: z.at.y + p[0].y - g.last.y });
      g.last = p[0];
    }
  });
  const lift = (e, z) => {
    const p = points(e), g = z.touch;
    // the finger left of two goes on moving the picture from where it is
    if (p.length === 1){ z.touch = { pinch: false, start: p[0], last: p[0], tap: false }; return; }
    if (p.length) return;
    z.touch = null;
    if (g && !g.pinch && g.tap && e.type === "touchend") cardPictureTap(z, g.last.x, g.last.y);
  };
  on("touchend", lift);
  on("touchcancel", lift);
  // the mouse: held down and dragged it moves a zoomed picture, and the click
  // that ends a drag is not a click on it
  on("pointerdown", (e, z) => {
    if (e.pointerType !== "mouse" || e.button) return;
    cardPictureSettle(z);
    z.drag = { start: { x: e.clientX, y: e.clientY }, last: { x: e.clientX, y: e.clientY }, moved: false };
  });
  on("pointermove", (e, z) => {
    const d = z.drag;
    if (!d || e.pointerType !== "mouse") return;
    if (!(e.buttons & 1)){ z.drag = null; return; }
    if (Math.hypot(e.clientX - d.start.x, e.clientY - d.start.y) > CARD_PICTURE_SLOP) d.moved = true;
    if (d.moved && cardPictureZoomed(z)) cardPictureMove(z, { ...z.at, x: z.at.x + e.clientX - d.last.x, y: z.at.y + e.clientY - d.last.y });
    d.last = { x: e.clientX, y: e.clientY };
  });
  on("click", (e, z) => {
    const dragged = z.drag?.moved;
    z.drag = null;
    if (!dragged) cardPictureTap(z, e.clientX, e.clientY);
  });
  // the wheel: with ctrlKey it is a trackpad pinch (or control and the wheel)
  // and zooms about the pointer; without, it moves a zoomed picture as a page
  // would scroll
  on("wheel", (e, z) => {
    cardPictureSettle(z);
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? doc.defaultView.innerHeight : 1;
    if (e.ctrlKey){
      const d = Math.max(-CARD_PICTURE_WHEEL_MOST, Math.min(CARD_PICTURE_WHEEL_MOST, e.deltaY * unit));
      cardPictureZoom(z, z.at.w / z.to.w * Math.exp(-d * CARD_PICTURE_WHEEL_ZOOM), e.clientX, e.clientY);
    } else if (cardPictureZoomed(z))
      cardPictureMove(z, { ...z.at, x: z.at.x - e.deltaX * unit, y: z.at.y - e.deltaY * unit });
  });
  for (const type of ["mousedown", "contextmenu"]) on(type, () => {});
  doc.body.appendChild(layer);
  return layer;
}

// the phone's magic box stands expanded in the browser's top layer, over
// everything else on the page (m.html, phoneMagicBig). a layer opened from
// inside it, a link's menu, goes up there too, over it, and comes down again
// as it shuts. from anywhere else, and on the Mac, whose box is never there,
// nothing changes
function cardTopLayer(layer, from){
  const box = from?.closest?.(".magicbox.big");
  if (!box || typeof layer.showPopover !== "function") return;
  let up = false;
  try { up = box.matches(":popover-open"); } catch (e) {}
  if (!up) return;
  layer.setAttribute("popover", "manual");
  layer.showPopover();
}
function cardTopLayerOff(layer){
  if (!layer.hasAttribute("popover")) return;
  try { layer.hidePopover(); } catch (e) {}
  layer.removeAttribute("popover");
}

// back is what had focus before the press that opened it, given back on close.
// answers false for a picture that has not drawn, which has nothing to show
function openCardPicture(img, back){
  if (cardPictureShown || !img.complete || !img.naturalWidth) return false;
  const doc = img.ownerDocument, win = doc.defaultView;
  const layer = cardPictureLayer(doc), veil = layer.querySelector(".picfull-veil");
  const big = doc.createElement("img");
  big.className = "picfull-img";
  big.src = img.currentSrc || img.src; big.alt = img.alt; big.draggable = false;
  big.style.borderRadius = win.getComputedStyle(img).borderRadius;
  const from = cardPictureRect(img), seen = from && cardPictureSeen(img);
  layer.appendChild(big);
  layer.classList.add("on");
  cardTopLayer(layer, img);
  const to = cardPictureFit(img.naturalWidth, img.naturalHeight, cardPictureBox(layer));
  cardPicturePlace(big, to);
  img.classList.add("picfull-from");
  const z = cardPictureShown = { img, big, layer, veil, to, at: to, back, closing: false,
    touch: null, drag: null, tapped: null };
  // it stands at full size now; the transform carries it back over the card's
  // picture, cut to the part of it the card shows, and lets go, which is what
  // lands it exactly
  const timing = { duration: cardPictureStill(win) ? 0 : CARD_PICTURE_MS, easing: CARD_PICTURE_EASE, fill: "both" };
  z.grow = z.opening = big.animate([
    { transform: cardPictureOver(from || to, to), clipPath: seen ? cardPictureClip(seen, from, to) : CARD_PICTURE_WHOLE },
    { transform: "none", clipPath: CARD_PICTURE_WHOLE }], timing);
  z.dim = veil.animate([{ opacity: 0 }, { opacity: CARD_PICTURE_VEIL }], timing);
  win.addEventListener("resize", refitCardPicture);
  return true;
}
// a window resized or a phone turned while it is open: it takes the new screen,
// at its fitted size
function refitCardPicture(){
  const z = cardPictureShown;
  if (!z || z.closing) return;
  cardPictureSettle(z);
  z.at = z.to = cardPictureFit(z.img.naturalWidth, z.img.naturalHeight, cardPictureBox(z.layer));
  cardPicturePlace(z.big, z.to);
}
function closeCardPicture(){
  const z = cardPictureShown;
  if (!z || z.closing) return;
  z.closing = true;
  clearTimeout(z.tapped?.timer);
  const doc = z.layer.ownerDocument, win = doc.defaultView;
  win.removeEventListener("resize", refitCardPicture);
  // focus goes back with the press or the key that closes, which is what lets a
  // phone bring its keyboard back with it
  if (z.back && z.back !== doc.body && z.back.isConnected && doc.activeElement !== z.back)
    z.back.focus({ preventScroll: true });
  // home is where the card's picture stands now, so a card that moved under the
  // copy is still met exactly, and the copy is cut down to the part of it the
  // card shows on the way, so it never covers what the card draws over the
  // rest. a picture the card has drawn again since, or keeps out of sight, has
  // no place to come to, and the copy only fades where it is
  const home = cardPictureRect(z.img), seen = home && cardPictureSeen(z.img);
  // the starting values are read above the cancels, which drop them to the
  // sheet's. caught halfway out it turns round from where it is, and takes only
  // the time it has spent getting there
  const cs = win.getComputedStyle(z.big);
  const start = { transform: cs.transform, clipPath: cs.clipPath && cs.clipPath !== "none" ? cs.clipPath : CARD_PICTURE_WHOLE, opacity: cs.opacity };
  const dim = win.getComputedStyle(z.veil).opacity;
  const part = cardPictureTurn(z.grow === z.opening ? z.grow : null);
  const still = cardPictureStill(win);
  const timing = { duration: still ? 0 : CARD_PICTURE_MS * part, easing: CARD_PICTURE_EASE, fill: "both" };
  z.grow?.cancel(); z.dim.cancel();
  z.grow = z.big.animate([start, seen ? { transform: cardPictureOver(home, z.at), clipPath: cardPictureClip(seen, home, z.at), opacity: 1 }
    : { transform: start.transform, clipPath: start.clipPath, opacity: 0 }], timing);
  z.dim = z.veil.animate([{ opacity: dim }, { opacity: 0 }], timing);
  const done = () => {
    z.big.remove(); z.dim.cancel();
    z.img.classList.remove("picfull-from");
    z.layer.classList.remove("on");
    cardTopLayerOff(z.layer);
    cardPictureShown = null;
  };
  // landed, the card's own picture is shown under the copy, which fades off it,
  // so the fades the card wears where it cuts the picture come in softly
  z.grow.onfinish = () => {
    if (!seen) return done();
    z.img.classList.remove("picfull-from");
    z.grow = z.big.animate([{ opacity: 1 }, { opacity: 0 }], { duration: still ? 0 : CARD_PICTURE_SETTLE_MS, fill: "both" });
    z.grow.onfinish = done;
  };
}

// ---- the card pages' keyboard commands ------------------------------------------
// Recognition is shared; listeners, state guards, cancellation and effects stay
// with each page. The order is part of the contract because some modifier
// predicates deliberately overlap or ignore extra modifiers.
const CARD_SHORTCUT_DEFINITIONS = [
  {
    action: "diagnostic", mini: false,
    match: e => e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey &&
      !e.repeat && !e.isComposing && !e.defaultPrevented &&
      (e.key === "m" || e.key === "M") ? true : null,
  },
  {
    action: "navigate", mini: true,
    match: e => e.ctrlKey && !e.metaKey && e.shiftKey &&
      (e.key === "ArrowLeft" || e.key === "ArrowRight")
      ? (e.key === "ArrowLeft" ? -1 : 1) : null,
  },
  {
    action: "plainNavigate", mini: true,
    match: e => !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey &&
      (e.key === "ArrowLeft" || e.key === "ArrowRight")
      ? (e.key === "ArrowLeft" ? -1 : 1) : null,
  },
  // up and down walk the open card list; a page with no such list leaves them alone
  {
    action: "drawerWalk", mini: false,
    match: e => !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && !e.isComposing &&
      (e.key === "ArrowUp" || e.key === "ArrowDown")
      ? (e.key === "ArrowUp" ? -1 : 1) : null,
  },
  // control+shift+comma matches the physical key: e.key reads "<" on a US layout but "," on iOS.
  // the settings drawer has no key
  {
    action: "cardsDrawer", mini: false,
    match: e => e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey &&
      !e.repeat && !e.isComposing && e.code === "Comma" ? true : null,
  },
  // control+shift+period, the key beside it, is the phone's card's magic box,
  // brought down in the same drawer from the other side; read off the physical
  // key for the same reason (">" on a US layout)
  {
    action: "boxDrawer", mini: false,
    match: e => e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey &&
      !e.repeat && !e.isComposing && e.code === "Period" ? true : null,
  },
  {
    action: "history", mini: false,
    match: e => e.ctrlKey && !e.metaKey && e.shiftKey &&
      (e.key === "ArrowUp" || e.key === "ArrowDown")
      ? (e.key === "ArrowUp" ? 1 : -1) : null,
  },
  // control+option+up and down step between the card's title, its response and
  // its typing box, the order they stand in (cardPlace): up is -1, down 1. no
  // text, editor or browser here gives the chord a meaning; Apple's screen
  // reader takes it while it is on. a held key's repeats are recognized so the
  // page can keep them from the browser
  {
    action: "place", mini: false,
    match: e => e.ctrlKey && e.altKey && !e.metaKey && !e.shiftKey && !e.isComposing &&
      (e.key === "ArrowUp" || e.key === "ArrowDown")
      ? (e.key === "ArrowUp" ? -1 : 1) : null,
  },
  // control+option+right puts the owner into the card's magic box, as a click
  // in it does, and control+option+left puts them back where they were on the
  // card: left is -1, right 1. the same chord pair as the one above, so the
  // same reasoning: no text, editor or browser here gives it a meaning, and
  // Apple's screen reader takes it while it is on
  {
    action: "magicJump", mini: false,
    match: e => e.ctrlKey && e.altKey && !e.metaKey && !e.shiftKey && !e.isComposing &&
      (e.key === "ArrowLeft" || e.key === "ArrowRight")
      ? (e.key === "ArrowLeft" ? -1 : 1) : null,
  },
  // command+z and control+z are the editor's undo and nothing of ours. The card
  // pages had a return-to-the-previous-card on that chord until 20260910; it
  // took the key away from the text being typed, so it is gone with no
  // replacement chord.
  {
    action: "create", mini: true,
    match: e => cardCreateShortcut(e) ? true : null,
  },
  {
    action: "tab", mini: false,
    match: e => e.metaKey && /^[1-9]$/.test(e.key) ? +e.key - 1 : null,
  },
  // command+0 opens the home page, as the house does, just before command+1 to
  // 9 pick the projects. the physical key (Digit0) so any layout has it; no
  // control, option or shift. like the other command keys it works from a typing
  // box too. chrome's own command+0, reset zoom, is blocked on the board
  // (chromeShortcutBlocked in index.html), so the key is free to take
  {
    action: "home", mini: false,
    match: e => e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.isComposing &&
      e.code === "Digit0" ? true : null,
  },
  // an Escape an input method takes is its own (imeKey)
  {
    action: "escape", mini: false,
    match: e => e.key === "Escape" && !imeKey(e) ? true : null,
  },
  // Enter alone selects the card on screen and puts the caret in its
  // composer. only the desktop board answers it, and only where nothing is
  // being typed; the composers take their own Enter before it gets here
  {
    action: "enter", mini: false,
    match: e => e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey &&
      !e.repeat && !e.isComposing && !e.defaultPrevented ? true : null,
  },
  // control+u unfolds the selected card's ticket while it wears the
  // ready-to-test fold, as a click on the folded corner does. nothing on this
  // mac, in chrome or in either shape of the composer answers control+u, so,
  // like control+s, it works from the card's own composer as well as anywhere
  // nothing is being typed
  {
    action: "unfold", mini: false,
    match: e => e.ctrlKey && !e.shiftKey && !e.metaKey && !e.altKey &&
      !e.repeat && !e.isComposing && !e.defaultPrevented &&
      (e.key === "u" || e.key === "U") ? true : null,
  },
  // control+shift+enter moves to the card that has waited longest, as the
  // second Enter of a double Enter does. a composer sends what it holds and
  // takes the key itself, so only a press nothing else answered gets here. a
  // held key's repeats are recognized so the page can keep them from the browser
  {
    action: "advance", mini: false,
    match: e => controlShiftEnter(e) && !e.isComposing && !e.defaultPrevented ? true : null,
  },
  // control+r jumps to a random card in the list whose ticket is neither green
  // nor grey
  {
    action: "random", mini: false,
    match: e => e.ctrlKey && !e.shiftKey && !e.metaKey && !e.altKey &&
      !e.isComposing && !e.defaultPrevented &&
      (e.key === "r" || e.key === "R") ? true : null,
  },
  // control+shift+[, ] and \ move the selected card to Doing, Deferred and
  // Done, typing or not. macOS text boxes give these chords no meaning and the
  // composer's editor is told to leave them to the page (PAGE_CHORDS in
  // compose-format.js), which cancels them on the way, so an event already
  // cancelled still counts here
  {
    action: "sectionChord", mini: true,
    match: e => e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey &&
      !e.repeat && !e.isComposing ? sectionChordOf(e) : null,
  },
  // the same three keys alone do the same, but only while nothing is being
  // typed, which each page checks against where the key landed
  {
    action: "sectionKey", mini: true,
    match: e => !e.ctrlKey && !e.metaKey && !e.repeat && !e.isComposing &&
      !e.defaultPrevented ? sectionKeyOf(e) : null,
  },
  // control+shift+' and ; step the ticket list to its next or previous
  // section: the phone's card list while it is out, the board's list while it
  // is on the page. Like the comma key they match the physical key, since what
  // the key types changes with the layout and the shift
  {
    action: "drawerSection", mini: false,
    match: e => e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey &&
      !e.repeat && !e.isComposing ? DRAWER_SECTION_STEPS.get(e.code) || null : null,
  },
  // control+shift+w and control+shift+s open or cut back the card's top and
  // bottom message bubbles, as a press on the bubble's arrow does (answeredKey).
  // like control+s they are read off the letter the key types. no text box or
  // editor here gives either chord a meaning, so they work from the card's
  // composer too. they stand after the chords read off a physical key, so a
  // layout whose ; or ' key types an s or a w keeps that key for those
  {
    action: "bubble", mini: false,
    match: e => e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey &&
      !e.repeat && !e.isComposing && !e.defaultPrevented
      ? (e.key === "w" || e.key === "W" ? "answered" : e.key === "s" || e.key === "S" ? "sent" : null) : null,
  },
  // control+s scrolls the selected card's response while held: down, or up
  // when a tap is followed at once by a hold. A held key's repeats are
  // recognized too, so the page can keep them from the editor and the browser,
  // and responseScrollKey never counts them as presses
  {
    action: "responseScroll", mini: false,
    match: e => responseScrollChord(e) && !e.defaultPrevented ? true : null,
  },
];

// Pure recognition over key/modifier fields. The finite mini scope sees only
// the two command families the existing mini capture listener owns.
function cardShortcut(event, scope = "card"){
  if (scope !== "card" && scope !== "mini") return null;
  for (const definition of CARD_SHORTCUT_DEFINITIONS){
    if (scope === "mini" && !definition.mini) continue;
    const value = definition.match(event);
    if (value !== null) return { action: definition.action, value };
  }
  return null;
}

// True means a callable page action was invoked. Dispatch does not cancel the
// event, stop propagation, schedule work, or imply that an async action ended.
function dispatchCardShortcut(event, actions, scope = "card"){
  const shortcut = cardShortcut(event, scope);
  const action = shortcut && actions && actions[shortcut.action];
  if (typeof action !== "function") return false;
  action(event, shortcut);
  return true;
}

// Plain arrows belong to the caret anywhere inside an editor, including a
// decorated contenteditable whose key target is one of its descendants.
function cardShortcutEditing(target){
  return !!target && typeof target.closest === "function" &&
    !!target.closest("textarea, input, [contenteditable], [role='textbox'], .cm-editor");
}

// A key held with Command or Control is a command of the page's, never typing,
// so a box being typed in lets it go on to the page and keeps the rest: letters,
// the arrows, Backspace and the like. Enter, Escape and Tab stay the box's own
// whatever is held with them
function pageChord(e){
  return (e.metaKey || e.ctrlKey) && e.key !== "Enter" && e.key !== "Escape" && e.key !== "Tab";
}

// control and shift and enter and nothing else: command sends as plain Enter
// does, and option does nothing of the page's
function controlShiftEnter(e){
  return e.key === "Enter" && e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey;
}

// control and enter alone is not the page's: on an iPhone with a keyboard the
// system opens its copy menu on it and the page never hears the Enter, so the
// move is on control+shift+enter and this key goes to the system untouched
function bareControlEnter(e){
  return e.key === "Enter" && e.ctrlKey && !e.shiftKey && !e.metaKey && !e.altKey;
}

// a key an input method takes: its Enter confirms the words it was building and
// sends nothing, and its Escape lets them go and leaves the caret where it is.
// WebKit ends the composition before that key arrives, so it comes with
// isComposing false and only its keyCode, 229, says so. the formatter's own
// Enter rule reads the same two (compose-format.js)
function imeKey(e){
  return e.isComposing || e.keyCode === 229;
}

// The card on screen stands raised, wearing its drop shadow, for as long as it
// is open: on load, on a switch of project, card or page, and after the home
// page, whether it is browsed or selected. Two quick presses on the empty page
// lower it, a double click on the board and a double tap on the phone, and
// that is the only thing that does; body.lowered is that one state, and the
// page's setBrowsing, which every showing and choosing of a card goes through,
// clears it. It is the look alone: browsing, which says what counts as read,
// keeps its own rules and is let go of as a press on the empty page used to
// let go of it
function setLowered(on){ document.body.classList.toggle("lowered", !!on); }
function lowerShown(){
  if (!selectedId || !els[selectedId]) return;
  unselectShown();
  setLowered(true);
}
// the phone hears no double tap of the browser's own, so it counts two: a tap
// is the second when it comes within the double tap window of the last and
// lands near it
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_PX = 30;
function tapAgain(last, at, x, y){
  return !!last && at - last.at < DOUBLE_TAP_MS && Math.hypot(x - last.x, y - last.y) <= DOUBLE_TAP_PX;
}

// the two standing boxes sit in the lists but are not cards to walk to
function isStandingBox(id){ return id === "0" || id === "t0"; }

// a green ticket: work is under way on the card. a done card the agent still
// holds keeps its green, as its row keeps pulsing
function ticketGreen(b){
  return queueState(b) === "working" ||
    (queueState(b) === "done" && cardState({ ...b, done: false, parked: false, state: null }) === "working");
}

// a grey ticket: a message is waiting for the agent to pick it up
function ticketQueued(b){ return queueState(b) === "queued"; }

// the id of a random card in pool, never the one on screen, a standing box, a
// green ticket or a grey one; null when none is left
function pickRandomCard(pool, currentId, random = Math.random){
  const open = pool.filter(b => b.id !== currentId && !isStandingBox(b.id) && !ticketGreen(b) && !ticketQueued(b));
  return open.length ? open[Math.floor(random() * open.length)].id : null;
}

// ---- the four section keys -------------------------------------------------------
// The chord is read off the physical key first, since shift turns e.key into
// {, } or | and control can leave it unusual, and off the character when the
// event names no such key. A key alone is read off the character it types, so
// a layout whose bracket key types a letter never moves a card.
const SECTION_KEY_CODES = new Map([["BracketLeft", "doing"], ["BracketRight", "docked"], ["Backslash", "deferred"], ["Backspace", "done"], ["Delete", "done"]]);
const SECTION_KEY_CHARS = new Map([["[", "doing"], ["]", "docked"], ["\\", "deferred"]]);
const SECTION_KEY_SHIFTED = new Map([["{", "doing"], ["}", "docked"], ["|", "deferred"], ["Backspace", "done"], ["Delete", "done"]]);

// the card list's sections are stepped by physical keys: Quote goes to the next
// and Semicolon to the previous
const DRAWER_SECTION_STEPS = new Map([["Quote", 1], ["Semicolon", -1]]);

function sectionChordOf(e){
  return SECTION_KEY_CODES.get(e.code) || SECTION_KEY_CHARS.get(e.key) ||
    SECTION_KEY_SHIFTED.get(e.key) || null;
}
function sectionKeyOf(e){ return SECTION_KEY_CHARS.get(e.key) || null; }

// what each section's chip names in its tooltip, so the keys are written once
const SECTION_KEY_HINTS = {
  doing: "Control + Shift + [, or [ when not typing",
  docked: "Control + Shift + ], or ] when not typing",
  deferred: "Control + Shift + \\, or \\ when not typing",
  done: "Control + Shift + Backspace or Delete",
};

// Where the chord may come from: anywhere nothing is being typed, the card's
// own composer in either shape (its textarea, or the editor that holds it), the
// card's own title while it is renamed, and its response while the caret stands
// in it (replyCaret). Every other field keeps the chord.
function sectionChordSource(target, el){
  if (!cardShortcutEditing(target)) return true;
  if (!el || !el.ta) return false;
  if (target === el.ta || target === el.reply || (el.titleEl && el.titleEl.contains(target))) return true;
  const editor = target.closest(".cm-editor");
  return !!editor && editor.contains(el.ta);
}

// ---- scrolling the response with control+s ---------------------------------------
// Holding the chord scrolls the selected card's response down from the first
// frame, slowly at first and faster the longer it is held. Tapping s and
// pressing it again within the double tap window, with control still held,
// scrolls up instead. Letting go of s or control eases the motion off; anything
// else that ends it (another key, the card or list changing, the window being
// left) stops it at once. The response scroller (el.replyview) holds the live
// reply and a history step alike. macOS text boxes give control+s no meaning,
// so the chord works from the card's composer too.
//
// The speed is shaped after WebKit's own Page Down and arrow keys, measured in
// a WKWebView: the speed rises while the key is down, to within 5 percent of a
// top speed in about a second, and holds there, and after letting go it dies
// away with a time constant of about 0.1 seconds. Here it starts at the steady
// pace this key used to have and rises along an S (smoothstep) that is within 5
// percent of the top after about a second, so nothing jolts at either end: a
// tap goes a line or two, and a long hold crosses a long response in a few
// seconds.
const RESPONSE_TAP_MS = 300;
// CSS pixels per second: the speed at the first frame, and the top speed
const RESPONSE_SCROLL_SPEED = 150;
const RESPONSE_SCROLL_TOP = 1800;
// how long the key is held at the first speed before the speed starts to rise
const RESPONSE_HOLD_MS = 1110;
// how long the rise then takes to go from the first speed to the top
const RESPONSE_RAMP_MS = 2667;
// after letting go the speed falls by a factor of e every this long, so the
// motion goes on for about the speed it had times this (180px from the top
// speed), and is over once it is under RESPONSE_EASE_END pixels a second
const RESPONSE_EASE_MS = 100;
const RESPONSE_EASE_END = 10;
// the longest frame gap counted, so a stalled page never catches up in a jump
const RESPONSE_FRAME_MAX_MS = 50;
// a press that finds nothing to scroll that way, or a hold that reaches the
// end, nudges the response's content this far along the pressed direction and
// back, so the key is seen to have landed
const RESPONSE_BOUNCE_PX = 7;
const RESPONSE_BOUNCE_MS = 250;
// the motion under way, or null
let responseScrolling = null;
// Only the phone in developer mode supplies this optional, isolated recorder.
let responseScrollTiming = null;
function noteResponseScroll(phase, run, frame, computed, callback){
  try { responseScrollTiming(phase, run, frame, computed, callback); } catch (_) {}
}
// the last down press, kept so a quick second press can turn it into an up
let responseLastPress = null;
// the bounce's running animations, so a quick second one replaces the first
let responseBouncing = [];

function stopResponseScroll(){
  if (responseScrolling && responseScrolling.frame) cancelAnimationFrame(responseScrolling.frame);
  if (responseScrollTiming && responseScrolling) noteResponseScroll("end", responseScrolling);
  responseScrolling = null;
}

function dropResponseScroll(){
  stopResponseScroll();
  responseLastPress = null;
}

// How far the response has gone, in pixels, once the key has been held for
// held milliseconds: the first speed all along, and on top of it, once the
// hold-off is over, the rise to the top speed along its S. The S is the
// smoothstep 3x^2 - 2x^3 over the ramp, so the rise adds up to x^3 - x^4/2,
// then to a straight run at the top speed. The distance for a frame is the
// difference of two of these, so it does not depend on how many frames the
// time is cut into.
function responseHeldPath(held){
  const x = Math.max(0, held - RESPONSE_HOLD_MS) / RESPONSE_RAMP_MS;
  const rise = x < 1 ? x * x * x * (1 - x / 2) : x - 0.5;
  return (RESPONSE_SCROLL_SPEED * held +
    (RESPONSE_SCROLL_TOP - RESPONSE_SCROLL_SPEED) * RESPONSE_RAMP_MS * rise) / 1000;
}

// the speed, in pixels a second, once the key has been held for held milliseconds
function responseHeldSpeed(held){
  const x = Math.min(1, Math.max(0, held - RESPONSE_HOLD_MS) / RESPONSE_RAMP_MS);
  return RESPONSE_SCROLL_SPEED + (RESPONSE_SCROLL_TOP - RESPONSE_SCROLL_SPEED) * x * x * (3 - 2 * x);
}

// How far an easing motion has gone, in pixels, eased milliseconds after the
// key was let go at speed from (pixels a second)
function responseEasePath(from, eased){
  return from * RESPONSE_EASE_MS / 1000 * (1 - Math.exp(-eased / RESPONSE_EASE_MS));
}

// Letting go: the motion under way eases off from the speed it has reached.
// Reduced motion stops it at once, as the bounce is left out for it.
function easeResponseScroll(){
  const run = responseScrolling;
  if (!run || run.eased != null) return;
  if (stillMotion()){
    stopResponseScroll();
    return;
  }
  run.from = responseHeldSpeed(run.held);
  run.eased = 0;
}

// control and s and nothing else, so control+shift+s is not the chord
function responseScrollChord(e){
  return e.ctrlKey && !e.shiftKey && !e.metaKey && !e.altKey && !e.isComposing &&
    (e.key === "s" || e.key === "S");
}

// Whether the response can move at all in dir (1 down, -1 up): false when it
// does not scroll, or already stands at that end.
function responseCanScroll(view, dir){
  const room = Math.max(0, view.scrollHeight - view.clientHeight);
  return dir > 0 ? view.scrollTop < room : view.scrollTop > 0;
}

// The edge bounce: the content inside the scroller (the answered panel and the
// answer) goes RESPONSE_BOUNCE_PX the way the scroll would have carried it and
// eases back. It runs on the independent translate property through the
// animation API, so no scroll position, style, focus, caret or draft is
// written. Reduced motion gets none. True means a bounce was started.
function responseScrollBounce(view, dir){
  if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  const parts = [...(view.children || [])].filter(part => typeof part.animate === "function");
  if (!parts.length) return false;
  for (const running of responseBouncing) running.cancel();
  const out = `0 ${-dir * RESPONSE_BOUNCE_PX}px`;
  responseBouncing = parts.map(part => part.animate([
    { translate: "0 0", easing: "cubic-bezier(.25, .8, .4, 1)" },
    { translate: out, offset: .4, easing: "cubic-bezier(.45, 0, .55, 1)" },
    { translate: "0 0" },
  ], { duration: RESPONSE_BOUNCE_MS }));
  return true;
}

// Where the chord may come from: the page itself, the card's own composer
// (its textarea, or the editor standing in for it), the card's own title while
// it is renamed, and anything else that is not a field, as the page itself is:
// the response, with its caret in it or not, a button on the card, or one on the
// bars around it, which a click leaves focused. The sent box, the answered
// panel, another card, a panel the page names in keyPanels and every other
// field keep the chord.
function responseScrollSource(target, el){
  const doc = el.replyview.ownerDocument;
  if (!target || target === doc || target === doc.body || target === doc.documentElement) return true;
  if (el.ta && target === el.ta) return true;
  if (el.reply && target === el.reply) return true;
  if (el.titleEl && el.titleEl.contains(target)) return true;
  const editor = typeof target.closest === "function" && target.closest(".cm-editor");
  if (editor) return !!el.ta && editor.contains(el.ta);
  if (cardShortcutEditing(target)) return false;
  if ((el.pendwrap && el.pendwrap.contains(target)) || (el.answwrap && el.answwrap.contains(target))) return false;
  if ((el.box || el.replyview).contains(target)) return true;
  if (keyPanels && typeof target.closest === "function" && target.closest(keyPanels)) return false;
  return !(typeof els === "object" && els &&
    Object.values(els).some(card => card && card !== el && card.box && card.box.contains(target)));
}

// A press or a motion still stands only for the same card, drawn by the same
// render, in the same project, with the same focus, on a visible page, with its
// response still connected and laid out.
function responseScrollStands(was, card){
  const view = card && card.el && card.el.replyview;
  return !!view && card.id === was.id && card.owner === was.owner && card.el === was.el &&
    was.doc.activeElement === was.focus && was.doc.visibilityState !== "hidden" &&
    !(card.el.box && card.el.box.isConnected === false) && view.isConnected !== false &&
    view.clientHeight > 0;
}

function responseScrollFrame(at){
  const run = responseScrolling;
  if (!run) return;
  const callback = responseScrollTiming ? performance.now() : 0;
  run.frame = 0;
  if (!responseScrollStands(run, run.find())){
    dropResponseScroll();
    return;
  }
  const view = run.el.replyview;
  const dt = Math.min(RESPONSE_FRAME_MAX_MS, Math.max(0, at - run.last));
  run.last = at;
  // the position is kept unrounded so slow motion is not lost to whole pixels,
  // and taken afresh when something else has moved the response
  if (Math.abs(view.scrollTop - run.pos) >= 1) run.pos = view.scrollTop;
  const room = Math.max(0, view.scrollHeight - view.clientHeight);
  // the frame's distance: along the rise while the key is held, along the ease
  // once it is let go, which is over when its speed is almost nothing
  let step, over = false;
  if (run.eased == null){
    step = responseHeldPath(run.held + dt) - responseHeldPath(run.held);
    run.held += dt;
  } else {
    step = responseEasePath(run.from, run.eased + dt) - responseEasePath(run.from, run.eased);
    run.eased += dt;
    over = run.from * Math.exp(-run.eased / RESPONSE_EASE_MS) < RESPONSE_EASE_END;
  }
  run.pos = Math.max(0, Math.min(room, run.pos + run.dir * step));
  const computed = responseScrollTiming ? performance.now() : 0;
  if (run.pos !== view.scrollTop) view.scrollTop = run.pos;
  if (responseScrollTiming) noteResponseScroll("step", run, at, computed, callback);
  if ((run.dir < 0 && run.pos === 0) || (run.dir > 0 && run.pos === room)){
    // the motion stops here, so the hold that reached the end bounces once
    stopResponseScroll();
    responseScrollBounce(view, run.dir);
    return;
  }
  if (over){
    stopResponseScroll();
    return;
  }
  run.frame = requestAnimationFrame(responseScrollFrame);
}

// The chord's keydown. find is the page's word on which card may be scrolled
// now: { id, owner, el }, or null while a menu, panel, overlay or swipe stands
// over the card. It is asked on every press and on every frame, so motion stops
// on a card the reader has left. True means the chord was taken from the
// editor and the browser.
function responseScrollKey(event, find){
  const card = find();
  const view = card && card.el && card.el.replyview;
  if (!view || !(view.clientHeight > 0) || !responseScrollSource(event.target, card.el)){
    dropResponseScroll();
    return false;
  }
  event.preventDefault();
  // a held key's repeats neither restart the motion nor turn it round
  if (event.repeat) return true;
  const at = performance.now();
  const doc = view.ownerDocument;
  const press = { id: card.id, owner: card.owner, el: card.el, doc, focus: doc.activeElement, at };
  const last = responseLastPress;
  const up = !!last && last.released != null && at - last.at < RESPONSE_TAP_MS &&
    responseScrollStands(last, card);
  stopResponseScroll();
  // an up is never the first press of the next pair, so the press after it goes down
  responseLastPress = up ? null : press;
  const dir = up ? -1 : 1;
  // nothing to scroll that way: the press still counts toward a double tap,
  // but it bounces instead of starting a motion that would stop at once
  if (!responseCanScroll(view, dir)){
    responseScrollBounce(view, dir);
    return true;
  }
  responseScrolling = {
    ...press, find, dir, last: at, pos: view.scrollTop, held: 0, eased: null, from: 0,
    frame: requestAnimationFrame(responseScrollFrame),
  };
  if (responseScrollTiming) noteResponseScroll("start", responseScrolling);
  return true;
}

// Letting go of s eases the motion off and keeps the press for the double tap
// window. Letting go of control eases it off and forgets the press. Any other
// modifier down stops it at once.
function responseScrollKeyUp(event){
  if (event.shiftKey || event.metaKey || event.altKey){
    dropResponseScroll();
    return;
  }
  if (!event.ctrlKey){
    responseLastPress = null;
    easeResponseScroll();
    return;
  }
  if (event.key === "s" || event.key === "S"){
    easeResponseScroll();
    if (responseLastPress && responseLastPress.released == null) responseLastPress.released = performance.now();
  } else if (event.key === "Control"){
    responseLastPress = null;
    easeResponseScroll();
  }
}

// Any other key, or the chord with a changed or added modifier (shift
// included), ends the motion and the double tap. The key itself is left alone.
// A repeat of control while it alone is held is not a change.
function responseScrollOtherKey(event){
  if (responseScrollChord(event)) return;
  if (event.key === "Control" && event.ctrlKey && !event.shiftKey &&
      !event.metaKey && !event.altKey) return;
  dropResponseScroll();
}

// The listeners that stop the motion are the page's own and are never gated by
// its overlays, so a release always lands. Losing the window or the page drops
// the motion too, in case its release never arrives.
function listenResponseScroll(){
  addEventListener("keydown", responseScrollOtherKey, true);
  addEventListener("keyup", responseScrollKeyUp, true);
  addEventListener("blur", dropResponseScroll);
  document.addEventListener("visibilitychange", dropResponseScroll);
}

// ---- the small helpers --------------------------------------------------------
function h(tag, cls, text){ const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

// One renderer and one URL policy serve every card surface. The server exposes
// short and full reply variants separately, so authored Markdown is never
// inspected here for transport punctuation.
function fmt(t){ return CardMarkdown.render(t || ""); }
function replyFull(b){ return b.replyFull == null ? (b.reply || "") : b.replyFull; }

// ---- the one state a card's colour and place come from ---------------------------
function cardState(b){
  // the server's state machine ships the one authoritative state per card;
  // the inline derivation below serves only queueState's unpark recompute
  // (state nulled in a copy) and an older server that omits the field
  const s = b.state || (
         b.done ? "done"
       : b.parked ? "parked"
       : (b.writing || b.bg) ? "working"
       // a card with prior replies was answered before, so it is never new even when a seeded board left its agent stamp at 0
       : (!b.agentTs && !b.pending && !b.replies) ? "new"
       : b.ball === "you" ? "yours"
       : "queued");
  // note is its own server-side progress state. It shares working's green
  // presentation without losing the semantic distinction on the wire.
  const shown = s === "note" ? "working" : s;
  // the machine never ships yours with messages still queued; this guard
  // covers the recomputed path, where an older reply can leave the ball on
  // the reader's side while a newer message is still in line, and that used to paint
  // the card yellow. only yours is rewritten, so done, parked and every
  // green state keep exactly the state they had
  return (shown === "yours" && b.pending > 0) ? "queued" : shown;
}
// the queue panel's view: a parked card sorts and colors as if open. state is
// nulled in the copy so cardState recomputes from the flags instead of handing
// back the server's "parked" when we peel the park off
function queueState(b){ return b.parked ? cardState({ ...b, parked: false, state: null }) : cardState(b); }
// The visible number a row shows before its title. Cards keep their internal
// ids for routing and never renumber from list position: an m-prefixed id (a
// card made on the board) shows its digits, an already-numeric seeded id shows
// as it is, and a purely non-numeric standing id shows none. The number is a
// plain figure with no # prefix.
// quick notes read card numbers through this function, so a change to the
// numbering has to be carried into the quick note system as well: in this
// file quickNoteRef and QUICK_NOTE_REF (the "card N", "cardN" and "cN" parser),
// quickNoteCard (figure to card), quickNoteAttachStep and the attachStep inside
// quickNoteSession (which card a note attaches to) and quickNotesByCard (the
// chip's grouping); in server.py _post_quicknote_new and _post_quicknote_attach
// (the attach routes, which take a card id) and _remove_empty_meta_box (frees a
// removed card's notes while QUICK_NOTES_ON is set); in parked/quick-note.js
// syncQuickNoteChip (the note chip); and the tests quick-note-refs.test.cjs and
// quick-notes.test.cjs. the quick note is hidden in this version and kept so it
// can come back
function ticketNum(id){
  const s = String(id == null ? "" : id);
  const m = /^m(\d+)$/.exec(s);
  if (m) return m[1];
  if (/^[0-9]/.test(s)) return s;
  return "";
}
// Omni Ticket v0 is a presentation derived from its canonical title. The card
// itself keeps the same id, routes and state as every other card. Three supplied
// artworks are defined today; later ticket numbers cycle through them without
// adding a stored variant field, so adding artwork later stays a local mapping.
function omniTicket(title){
  const match = /^Omni Ticket #([1-9]\d*)$/.exec(String(title == null ? "" : title));
  if (!match) return null;
  const number = Number(match[1]);
  if (!Number.isSafeInteger(number)) return null;
  const variant = ((number - 1) % 3) + 1;
  return { number, variant, src: "/assets/ticket-" + variant + ".webp" };
}
// ---- the line an empty typing box shows -------------------------------------
// a new reader could not tell where a card's typing box was, so an empty one
// shows one of these lines in light grey where the words go, and it goes the
// moment anything is typed. a card keeps its line until a message is sent on
// it, and each send gives it a new one. the new line comes from a shuffled bag
// of all twenty that belongs to the card: no line comes back until the other
// nineteen have been shown, then the bag is shuffled again, and never opens
// with the line just shown. a card with nothing saved starts with a random
// line. each card's line and bag are kept in this browser's localStorage, so
// reopening the card, switching cards, typing and deleting, or reloading the
// page does not change the line, and the Mac and the phone each keep their own.
// a card that is gone from the board loses its entry. the onboarding page's box
// and a card's title never show one
const COMPOSE_LINES = [
  "Make Opus 6 and no mistakes pls …",
  "Make me a billion dollar company …",
  "Who is JSON?",
  "It's SI not AI!",
  "You're absolutely right!",
  "Let's run some smoke tests?",
  "Delete the failing tests …",
  "Prove P = NP by lunch",
  "Cite a paper that agrees with me",
  "p < 0.05, make it happen …",
  "Explain my own code to me?",
  "Ignore all previous instructions …",
  "Do what I meant, not what I said …",
  "Uber, but for cats …",
  "Rename it final_v2_FINAL …",
  "Turn my spaghetti into lasagna …",
  "Fewer em dashes, more answers …",
  "Explain it like I'm a PM",
  "Reply in under 900 words?",
  "Make the error bars smaller …",
];
const COMPOSE_STORE = "composelines";
let composeMemory = {};   // the same map, for a browser that will not keep it
function composeRead(){
  try {
    const kept = JSON.parse(localStorage.getItem(COMPOSE_STORE) || "null");
    if (kept && typeof kept === "object" && !Array.isArray(kept)) return kept;
  } catch (e) {}
  return composeMemory;
}
function composeWrite(all){
  composeMemory = all;
  try { localStorage.setItem(COMPOSE_STORE, JSON.stringify(all)); } catch (e) {}
}
// a saved entry is { line, bag }: the shown line and the lines still to come,
// both as places in COMPOSE_LINES. one that does not add up is not trusted
function composeEntryOk(e){
  const n = COMPOSE_LINES.length;
  const place = x => Number.isInteger(x) && x >= 0 && x < n;
  return !!e && place(e.line) && Array.isArray(e.bag) && e.bag.length < n &&
    e.bag.every(place) && new Set(e.bag).size === e.bag.length && !e.bag.includes(e.line);
}
function composeShuffled(){
  const bag = COMPOSE_LINES.map((_, i) => i);
  for (let i = bag.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  return bag;
}
// the next line for a card: the bag's next, and a new shuffled bag when it is
// empty, turned over if it would open with the line just shown. the bag is
// dealt from its end
function composeDraw(entry){
  let bag = entry ? entry.bag.slice() : [];
  if (!bag.length){
    bag = composeShuffled();
    if (entry && bag[bag.length - 1] === entry.line){
      const j = Math.floor(Math.random() * (bag.length - 1));
      [bag[bag.length - 1], bag[j]] = [bag[j], bag[bag.length - 1]];
    }
  }
  return { line: bag.pop(), bag };
}
// the card's line as it stands: a card with nothing saved draws its first
function composeLine(id){
  const key = String(id == null ? "" : id);
  const all = composeRead();
  if (!composeEntryOk(all[key])) composeWrite({ ...all, [key]: composeDraw(null) });
  return COMPOSE_LINES[composeRead()[key].line];
}
// a message has been sent on the card: it takes the next line
function composeNext(id){
  const key = String(id == null ? "" : id);
  const all = composeRead();
  composeWrite({ ...all, [key]: composeDraw(composeEntryOk(all[key]) ? all[key] : null) });
  return composeLine(key);
}
// the cards on the board are the only ones that keep an entry
function composeKeep(ids){
  const all = composeRead(), live = new Set([...ids].map(String));
  const gone = Object.keys(all).filter(key => !live.has(key));
  if (!gone.length) return;
  const kept = {};
  for (const key of Object.keys(all)) if (live.has(key)) kept[key] = all[key];
  composeWrite(kept);
}
// a send on the card: its box takes the next line now, in the plain field and
// in the editor that may be standing in for it. el is the page's object for the
// card, with its ta and its field
function composeTurn(id, el){
  const line = composeNext(id);
  if (el.field && el.field.refreshPlaceholder) el.field.refreshPlaceholder();
  else el.ta.placeholder = line;
}
// ---- the words a card's row was left holding ------------------------------------
// what is typed in a card's row and not sent is kept in this browser's
// localStorage as it is typed, with the files that finished uploading for it,
// so a reload, a restart or a force close gives the card its row back as it
// was left. one entry a card: { text, files }, the text as the row holds it,
// markdown and all, and each file as the board's own address for it with what
// its square shows. a file still on its way is not kept. nothing here goes to
// the board. a send the board has taken or an emptied row takes the entry away,
// and a card that is gone from the board loses it. the Mac board and its phone
// view share one browser and so one store; the phone keeps its own
const DRAFT_STORE = "composedrafts";
let draftMemory = {};   // the same map, for a browser that will not keep it
// an absent entry is an empty store and not a reason to read the memory: the
// Mac board and its phone view share the store, and either may have emptied it
function draftsRead(){
  let raw;
  try { raw = localStorage.getItem(DRAFT_STORE); } catch (e) { return draftMemory; }
  try {
    const kept = JSON.parse(raw || "null");
    if (kept && typeof kept === "object" && !Array.isArray(kept)) return kept;
  } catch (e) {}
  return {};
}
function draftsWrite(all){
  draftMemory = all;
  try {
    if (Object.keys(all).length) localStorage.setItem(DRAFT_STORE, JSON.stringify(all));
    else localStorage.removeItem(DRAFT_STORE);
  } catch (e) {}
}
// a kept file is only ever one of the board's own uploads
function draftFileOk(f){
  return !!f && typeof f.url === "string" && f.url.startsWith("/uploads/") && typeof f.name === "string";
}
// the card's kept draft, or null. one that does not add up is not trusted
function draftOf(id){
  const e = draftsRead()[String(id == null ? "" : id)];
  if (!e || typeof e.text !== "string" || !Array.isArray(e.files)) return null;
  return { text: e.text, files: e.files.filter(draftFileOk) };
}
// the card's draft as it stands now; a row with nothing in it keeps nothing
function draftPut(id, text, files){
  const key = String(id == null ? "" : id);
  const all = { ...draftsRead() };
  const kept = (files || []).filter(draftFileOk);
  if (!String(text || "").trim() && !kept.length){
    if (!(key in all)) return;
    delete all[key];
  } else all[key] = { text: String(text || ""), files: kept };
  draftsWrite(all);
}
function draftClear(id){ draftPut(id, "", []); }
// the cards on the board are the only ones that keep a draft
function draftKeep(ids){
  const all = draftsRead(), live = new Set([...ids].map(String));
  const gone = Object.keys(all).filter(key => !live.has(key));
  if (!gone.length) return;
  const kept = {};
  for (const key of Object.keys(all)) if (live.has(key)) kept[key] = all[key];
  draftsWrite(kept);
}
// what a tray square needs to stand again, and nothing of the file itself
function draftFile(it){
  return { url: it.url, name: it.name, kind: it.kind, ext: it.ext, total: it.total };
}
function draftCardOf(el){
  if (typeof els !== "object" || !els) return null;
  return Object.keys(els).find(id => els[id] === el) || null;
}
// the row and the uploaded files of a built card, written down. a kept file
// this page's tray has never held stays kept: the Mac board's files are not
// handed to its phone view, and typing there must not lose them. of the Mac
// board and its phone view only the one on screen writes, since the other's
// rows can be empty or behind until the next hand over
function draftSave(id){
  if (globalThis.macPhoneInactive) return;
  const el = typeof els === "object" && els ? els[id] : null;
  if (!el || !el.ta) return;
  const own = (el.trayItems || []).filter(it => it.state === "done" && it.url);
  const held = el.trayHeld || new Set();
  const other = (draftOf(id)?.files || []).filter(f => !held.has(f.url) && !own.some(it => it.url === f.url));
  const words = [...draftUnsent(el), el.ta.value].filter(text => String(text).trim()).join("\n\n");
  draftPut(id, words, [...other, ...own.map(draftFile)]);
}
// the words of the Mac board's sends the board has not confirmed: on their way,
// or held under the fail mark. they live in the page alone (sentLaunch), so the
// draft keeps them, ahead of the row's own words, until the board has them, and
// a reload gives them back in the row. the phone's sent list holds only what
// the board confirmed; its own unsent messages are its operations' to keep
function draftUnsent(el){
  return [...(el.sentItems || []).filter(sentUndelivered), ...(el.sentHeld || [])].map(m => m.text);
}
// a card just built takes its kept draft back: the words, when the row is
// empty, with the caret at their end, and the files into its tray. nothing is
// focused, scrolled or opened
function draftRestore(el, id){
  const kept = draftOf(id);
  if (!el || !kept) return;
  if (!el.ta.value && kept.text){
    el.ta.value = kept.text;
    try { el.ta.setSelectionRange(kept.text.length, kept.text.length); } catch (e) {}
  }
  trayRestore(el, kept.files);
  el.tick();
}
// ---- pictures the board could not hand over -----------------------------------
// a phone's connection drops and returns under the app all the time, and a
// picture asked for just then fails once and stays failed: the browser never
// asks again by itself, and a row, a card and a reply keep their element for as
// long as the page is open. so the page does the asking. a failed picture is
// asked for again a little later, three times, and again whenever the app comes
// back to the front or the phone is back online. the Omni art on a ticket or a
// card is out of sight while it is failed, so no broken-image box is ever drawn
// there, and shows when it has loaded; a picture in a card's words stays where
// it is in the text. watchPictures is started once by the page
const PICTURE_RETRY_MS = [3000, 10000, 30000];
const PICTURES = ".cardmd img[src], img.omni-art, img.omni-card-art";
const PICTURES_HIDDEN = "img.omni-art, img.omni-card-art";
function watchPictures(){
  const failed = new Set();        // pictures that have failed and have not loaded since
  const tries = new WeakMap();     // a picture -> the address and the asks made of it
  const ask = image => {
    if (image.isConnected === false){ failed.delete(image); return; }
    if (image.hasAttribute("srcset")) return;
    const src = image.getAttribute("src");
    if (!src) return;
    image.removeAttribute("src");
    image.src = src;
  };
  const ours = e => {
    const image = e.target;
    return image && image.tagName === "IMG" && image.matches(PICTURES) ? image : null;
  };
  document.addEventListener("error", e => {
    const image = ours(e);
    if (!image) return;
    failed.add(image);
    if (image.matches(PICTURES_HIDDEN)) image.style.display = "none";
    const src = image.getAttribute("src");
    let kept = tries.get(image);
    if (!kept || kept.src !== src){ kept = { src, n: 0 }; tries.set(image, kept); }
    if (kept.n >= PICTURE_RETRY_MS.length) return;
    setTimeout(() => { if (failed.has(image)) ask(image); }, PICTURE_RETRY_MS[kept.n++]);
  }, true);
  document.addEventListener("load", e => {
    const image = ours(e);
    if (!image) return;
    failed.delete(image);
    tries.delete(image);
    if (image.matches(PICTURES_HIDDEN)) image.style.display = "";
  }, true);
  const wake = () => {
    for (const image of [...failed]){
      if (image.isConnected === false){ failed.delete(image); continue; }
      tries.delete(image);
      ask(image);
    }
  };
  document.addEventListener("visibilitychange", () => { if (!document.hidden) wake(); });
  window.addEventListener("pageshow", wake);
  window.addEventListener("online", wake);
}
function omniArt(info, cls){
  const image = h("img", cls);
  image.src = info.src;
  image.alt = "";
  image.draggable = false;
  image.dataset.variant = String(info.variant);
  image.setAttribute("aria-hidden", "true");
  return image;
}
// The card itself reads "Omni Card #N" while the ticket rows keep the stored
// "Omni Ticket #N", so the two teach a ticket and a card apart. Only the words
// on the card change: the stored title, the numbering and identity all stay
// the canonical ones.
function omniCardTitle(title){
  const info = omniTicket(title);
  return info ? "Omni Card #" + info.number : String(title == null ? "" : title);
}
// The words that ask the board for an Omni ticket, kept character for character
// with the server's _omni_entry so the page and the board can never read one
// title two ways. The title's first line, cut at 80 characters the way a stored
// title is, is split on white space, lowercased and read as a set of words, and
// it asks only when that set is exactly {omni}, {omni, card} or {omni, ticket},
// or one of the last two with one number, written N or #N: a whole number from
// 1 with no leading zero, no larger than a script holds exactly. Order and
// repeats do not matter, so "ticket omni" asks too; any other word, a second
// number or a bare {omni, N} does not.
const OMNI_MAX = Number.MAX_SAFE_INTEGER;
const OMNI_BREAK = /[\n\r\v\f\x1c\x1d\x1e\x85\u{2028}\u{2029}]/u;
const OMNI_SPACE = /[\t\n\v\f\r \xa0\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}]+/u;
const OMNI_NUMBER = /^#?([1-9][0-9]*)$/;
function omniEntry(text){
  const line = String(text == null ? "" : text).split(OMNI_BREAK)[0].slice(0, 80);
  const words = new Set(line.toLowerCase().split(OMNI_SPACE).filter(Boolean));
  if (!words.delete("omni")) return false;
  let kinds = 0, numbers = 0;
  for (const word of words){
    const match = OMNI_NUMBER.exec(word);
    if (word === "card" || word === "ticket") kinds++;
    else if (match && Number(match[1]) <= OMNI_MAX) numbers++;
    else return false;
  }
  return kinds <= 1 && numbers <= (kinds ? 1 : 0);
}
// the number the board gives the next Omni ticket in a lane, counted the way
// the server counts it: the highest canonical number already there, plus one.
// the card shows it the moment the word is committed, and the next reading of
// the board writes the server's own number over it should the two differ
function omniNextNumber(boxes, owner){
  let top = 0;
  for (const b of boxes || []){
    if ((b.owner || "facilitator") !== owner) continue;
    const info = omniTicket(b.title);
    if (info && info.number > top) top = info.number;
  }
  return top + 1;
}
// what a committed title does to the card's Omni face: dir is "in" as the card
// becomes Omni and "out" as it stops being one, and sweep is false where the
// reader asked for reduced motion, so the face simply changes. a name left as
// it was, or one that keeps the card on the side it was on, asks for nothing
function omniRetitle(wasOmni, shown, typed, reduced){
  const name = String(typed == null ? "" : typed).trim();
  if (!name || name === shown) return null;
  const becomes = omniEntry(name);
  const dir = becomes && !wasOmni ? "in" : !becomes && wasOmni ? "out" : null;
  return dir ? { dir, sweep: !reduced } : null;
}
// Keep an expanded card in step when an inline rename crosses into or out of
// the canonical Omni title. Ticket-list rows rebuild on title changes already.
// a sweep in flight owns the card's face until it lands, so a reading that
// arrives meanwhile is kept for it and drawn once the light has passed
function syncOmniCard(el, b){
  if (!el || !el.box || !el.titleEl) return null;
  if (el.omniSweep){ el.omniSweep.latest = b; return omniTicket(b && b.title); }
  return paintOmniCard(el, b);
}
function paintOmniCard(el, b){
  const info = omniTicket(b && b.title);
  el.box.classList.toggle("omni-card", !!info);
  if (el.toc) el.toc.classList.toggle("omni-card", !!info);
  const head = el.titleEl.parentNode;
  let image = head && head.querySelector(".omni-card-art");
  if (!info){ if (image) image.remove(); return null; }
  if (!image){ image = omniArt(info, "omni-card-art"); head.insertBefore(image, el.titleEl); }
  image.src = info.src;
  image.dataset.variant = String(info.variant);
  return info;
}
function appendOmniRowArt(row, inner, b){
  const info = omniTicket(b && b.title);
  if (!info) return null;
  row.classList.add("omni-ticket");
  inner.appendChild(omniArt(info, "omni-art"));
  return info;
}

// ---- the Omni sweep ------------------------------------------------------------
// sunlight crosses the whole card on its diagonal as a committed title makes it
// an Omni card, from the bottom left corner to the top right, and a glint
// tings on that corner the moment the light reaches it. a card leaving Omni
// takes the same light back the other way, top right to bottom left, with no
// glint. the title's words and the art change under the light, in the frame
// its centre passes them. the light itself is drawn by the page's .omni-sweep
// rule and the glint by its .omni-glint; this moves the one and places the other
const OMNI_SWEEP_MS = 600;
// how far the light reaches either side of its centre, on the sweep's own 0..1
// measure: the page's widest falloff, so the run starts and ends with none of it on the card
const OMNI_SWEEP_REACH = 0.24;
const OMNI_GLINT_MS = 300;   // the page's omni-glint keyframes run this long
// ease in and out on a half cosine: quick through the middle, soft at both
// ends, and never past where it is going
function omniEase(x){ return (1 - Math.cos(Math.PI * Math.min(Math.max(x, 0), 1))) / 2; }
// where a point stands on the sweep: 0 at the card's bottom left corner, 1 at
// its top right, and one value along every line parallel to the other diagonal,
// which is exactly how a "to top right" gradient lays out its stops
function omniSweepSpot(frame, x, y){
  return ((x - frame.left) / frame.width + (frame.bottom - y) / frame.height) / 2;
}
// the light's centre at ms into the sweep, run backward on the way out
function omniSweepAt(ms, dir){
  const k = omniEase(ms / OMNI_SWEEP_MS);
  return -OMNI_SWEEP_REACH + (dir === "out" ? 1 - k : k) * (1 + 2 * OMNI_SWEEP_REACH);
}
function omniSweepPassed(at, spot, dir){ return dir === "out" ? at <= spot : at >= spot; }
// the point the glint sits on: the card's top right corner, moved in along the
// diagonal onto the rounded edge itself, where the corner's curve crosses it
function omniGlintPoint(rect, radius){
  const inset = (radius || 0) * (1 - Math.SQRT1_2);
  return { x: rect.right - inset, y: rect.top + inset };
}
// the ting on the card's corner. the card is the frame the page draws it in,
// its main; the glint hangs off the body at that corner's place on the screen,
// so the card's own rounded clip cannot cut the rays that reach past its edge.
// it pops, holds and shrinks away on the page's keyframes, then takes itself away
function omniGlint(el, frame){
  const card = (el.box.closest && el.box.closest("main")) || null;
  const rect = card ? card.getBoundingClientRect() : frame;
  const radius = card && typeof getComputedStyle === "function"
    ? parseFloat(getComputedStyle(card).borderTopRightRadius) || 0 : 0;
  const point = omniGlintPoint(rect, radius);
  const glint = h("div", "omni-glint");
  glint.innerHTML = "<i></i><i></i>";   // the two diagonal rays; the long cross is its own ::before and ::after
  glint.style.left = point.x + "px";
  glint.style.top = point.y + "px";
  document.body.appendChild(glint);
  const gone = () => glint.remove();
  glint.addEventListener("animationend", gone);
  setTimeout(gone, OMNI_GLINT_MS + 200);   // a page out of sight runs no animation to end
  return glint;
}
// a title where the change is seen: the middle of its words, together with the
// art beside them when there is art
function omniTitleCentre(t, art){
  let r = t.getBoundingClientRect();
  if (t.firstChild && typeof document.createRange === "function"){
    const rg = document.createRange();
    rg.selectNodeContents(t);
    const words = rg.getBoundingClientRect();
    if (words.width && words.height) r = words;
  }
  let { left, top, right, bottom } = r;
  const a = art && art.getBoundingClientRect();
  if (a && a.width){
    left = Math.min(left, a.left); top = Math.min(top, a.top);
    right = Math.max(right, a.right); bottom = Math.max(bottom, a.bottom);
  }
  return { x: (left + right) / 2, y: (top + bottom) / 2 };
}
// the card's title on the sweep's measure
function omniTitleSpot(el, frame){
  const head = el.titleEl.parentNode;
  const c = omniTitleCentre(el.titleEl, head && head.querySelector(".omni-card-art"));
  return omniSweepSpot(frame, c.x, c.y);
}
// the card's words and art as one Omni state. the outline keeps the title as
// it is stored; the words are left alone while the reader is typing in them
function omniFace(el, title){
  if (!el.titleEl.isContentEditable){ el.titleEl.textContent = omniCardTitle(title); fitTitle(el.titleEl); }
  if (el.tocTitle) el.tocTitle.textContent = title;
  return paintOmniCard(el, { title });
}

// ---- the ticket's sweep ----------------------------------------------------------
// the card's row in the ticket list takes the same light in the same frames,
// with no glint, and changes to its Omni name and art, or back, as the light
// passes its own title. the list redraws its rows from each reading of the
// board, so the sweep finds them again every frame by the id each page marks
// them with, lays the light back on a row drawn afresh and puts on it the face
// the light has reached. a row with no size, not drawn or out of the page's
// layout, simply takes the face it ends on
function omniRows(id){
  return [...document.querySelectorAll(".trow")].filter(row => row.dataset && row.dataset.id === id);
}
// a row's place on the sweep. its light is laid at 45 degrees, so a point's
// value is how far it has come along that direction: 0 at the bottom left
// corner, 1 at the top right, the same run a "45deg" gradient lays its stops on
function omniRowSpot(frame, x, y){
  return ((x - frame.left) + (frame.bottom - y)) / (frame.width + frame.height);
}
// a row's words and art as one Omni state, the way appendOmniRowArt draws it.
// the row reads the stored title, Omni Ticket #N, where the card reads Omni Card #N
function omniRowFace(row, title){
  const inner = row.querySelector(".trowin"), ttl = inner && inner.querySelector(".ttl");
  if (!ttl) return;
  const info = omniTicket(title);
  row.classList.toggle("omni-ticket", !!info);
  if (ttl.textContent !== title) ttl.textContent = title;
  let art = inner.querySelector(".omni-art");
  if (!info){ if (art) art.remove(); return; }
  if (!art){ art = omniArt(info, "omni-art"); inner.insertBefore(art, ttl); }
  if (art.dataset.variant !== String(info.variant)){ art.src = info.src; art.dataset.variant = String(info.variant); }
}
function omniRowsFace(id, title){ for (const row of omniRows(id)) omniRowFace(row, title); }
// the title a sweep ends on: becoming Omni, the board's own number once a
// reading has brought it and the page's count of it until then
function omniSweepTo(run){ return omniSweepFresh(run) ? run.latest.title : run.title; }
// one frame of the rows' light, at the light's place `at`
function omniRowsStep(run, at){
  for (const row of omniRows(run.id)){
    const frame = row.getBoundingClientRect();
    let light = row.querySelector(".omni-sweep");
    if (!frame.width || !frame.height){ if (light) light.remove(); omniRowFace(row, omniSweepTo(run)); continue; }
    if (!light){ light = h("div", "omni-sweep"); row.appendChild(light); }
    light.style.setProperty("--omni-p", at.toFixed(4));
    if (!run.rowCrossed){
      const inner = row.querySelector(".trowin"), ttl = inner && inner.querySelector(".ttl");
      const c = ttl && omniTitleCentre(ttl, inner.querySelector(".omni-art"));
      if (c && omniSweepPassed(at, omniRowSpot(frame, c.x, c.y), run.dir)) run.rowCrossed = true;
    }
    omniRowFace(row, run.rowCrossed ? omniSweepTo(run) : run.rowFrom);
  }
}
function omniRowsEnd(run){
  for (const row of omniRows(run.id)){
    const light = row.querySelector(".omni-sweep");
    if (light) light.remove();
    omniRowFace(row, omniSweepTo(run));
  }
}
// a committed name, carried onto the card's face: lit where a card crosses into
// or out of Omni, at once where the reader asked for reduced motion or where
// the card is not laid out. a title that asks for Omni shows the lane's next
// number, whatever number was typed with it, since that is the number the board gives
function omniRetitleCard(id, shown, name){
  const el = els[id];
  if (!el || !el.box || !el.titleEl) return;
  omniSweepEnd(el);   // a sweep still running lands first
  const reduced = !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
  const plan = omniRetitle(el.box.classList.contains("omni-card"), shown, name, reduced);
  let title = name;
  if (omniEntry(name)){
    const b = stateBoxOf(id);
    title = "Omni Ticket #" + omniNextNumber(lastState && lastState.boxes, (b && b.owner) || "facilitator");
  }
  const land = () => { omniFace(el, title); omniRowsFace(id, title); };
  if (!plan){ if (omniTicket(title)) land(); return; }
  if (!plan.sweep || !omniSweep(el, id, plan.dir, title)) land();
}
function omniSweep(el, id, dir, title){
  if (typeof requestAnimationFrame !== "function") return false;
  const light = h("div", "omni-sweep");
  light.style.setProperty("--omni-p", String(omniSweepAt(0, dir)));
  el.box.appendChild(light);
  const frame = light.getBoundingClientRect();
  if (!frame.width || !frame.height){ light.remove(); return false; }
  const spot = omniTitleSpot(el, frame);
  // the row starts from the title the board last gave it
  const was = stateBoxOf(id);
  const run = el.omniSweep = { id, dir, title, light, latest: null, crossed: false, glint: null,
                               rowFrom: was ? String(was.title || "") : "", rowCrossed: false,
                               start: null, frame: 0, timer: 0 };
  const tick = now => {
    if (el.omniSweep !== run) return;
    if (run.start == null) run.start = now;
    const ms = now - run.start;
    const at = omniSweepAt(ms, dir);
    light.style.setProperty("--omni-p", at.toFixed(4));
    if (!run.crossed && omniSweepPassed(at, spot, dir)) omniSweepCross(el, run);
    omniRowsStep(run, at);
    // the light's centre has reached the top right corner: the way in ends on a ting
    if (dir === "in" && !run.glint && at >= 1) run.glint = omniGlint(el, frame);
    if (ms >= OMNI_SWEEP_MS) omniSweepEnd(el);
    else run.frame = requestAnimationFrame(tick);
  };
  run.frame = requestAnimationFrame(tick);
  // a page out of sight draws no frames, and the card still has to land
  run.timer = setTimeout(() => { if (el.omniSweep === run) omniSweepEnd(el); }, OMNI_SWEEP_MS + 250);
  return true;
}
// a reading that arrived during the sweep speaks for the card only when it is
// already on the side the sweep is taking the card to. one fetched before the
// board had the new name would put the old face back under the light
function omniSweepFresh(run){
  return !!(run.latest && (!!omniTicket(run.latest.title)) === (run.dir === "in"));
}
function omniSweepCross(el, run){
  run.crossed = true;
  omniFace(el, omniSweepTo(run));
}
function omniSweepEnd(el){
  const run = el && el.omniSweep;
  if (!run) return;
  if (!run.crossed) omniSweepCross(el, run);
  el.omniSweep = null;
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(run.frame);
  clearTimeout(run.timer);
  run.light.remove();
  omniRowsEnd(run);
  if (omniSweepFresh(run)) omniFace(el, run.latest.title);
}
// The ready-to-test marker's display gate. The board keeps a durable per-card
// flag (b.testing); it paints only while the card is actually awaiting the
// reader, so a card that returns to work, queues or is done keeps its own
// colour. A parked card that still awaits the reader qualifies through queueState.
function testReady(b){ return !!(b && b.testing) && queueState(b) === "yours"; }
// ---- unfolding the ready-to-test fold ------------------------------------------
// the fold is the whole of the marker, so unfolding a ticket is lowering it: the
// page asks the board for /testing v=0, the route the agent lowers it by, and
// draws what the board answers. two ways ask it, a click on the folded corner
// and control+u on the selected card, and only while the ticket wears the fold.
// the folded corner is the top right --fold square of the row's border box, the
// flap and the cut corner beside it together. x is measured in from the row's
// right edge and y down from its top
function foldHit(x, y, fold){ return fold > 0 && x >= 0 && y >= 0 && x <= fold && y <= fold; }
function onFold(row, e){
  if (!row || !row.classList.contains("testc")) return false;
  const r = row.getBoundingClientRect();
  const fold = parseFloat(getComputedStyle(row).getPropertyValue("--fold")) || 0;
  return foldHit(r.right - e.clientX, e.clientY - r.top, fold);
}
function unfoldTicket(id){
  return fetch("/testing?box=" + encodeURIComponent(id) + "&v=0", { method: "POST" })
    .catch(() => {}).then(() => poll());
}
// control+u's one path on either page: the selected card, when the key comes
// from where the section chords may come from and the card wears the fold.
// true means the board was asked
function unfoldSelected(e, id, el){
  if (!id || !el || !sectionChordSource(e.target, el)) return false;
  const b = lastState?.boxes.find(x => x.id === id);
  if (!testReady(b)) return false;
  e.preventDefault();
  unfoldTicket(id);
  return true;
}
// the strict await of the bar count and auto-select: pending vetoes it, and
// so does work in flight, claimed or registered; green outranks the ball
function awaitsYou(b){
  const s = cardState(b);
  // done/parked and work-in-flight are all folded into the state; a still-new
  // card only awaits you when the ball sits with you, and pending vetoes the
  // strict await either way
  return (s === "yours" || (s === "new" && b.ball === "you")) && !(b.pending > 0);
}
// ---- the chosen view, one per project ----------------------------------------
// doing, docked, deferred and done choose a view of one project's cards, so the choice
// belongs to that project and not to the page. it used to be a single variable
// the whole page shared, which is why picking done in one project opened every
// other project on done as well. it is kept per lane now, written the moment a
// button is pressed and read again wherever the list is drawn or walked, so a
// project nobody has chosen a view for opens on doing.
//
// the record is this browser's own, kept the way the open tab ("activeproj") and
// the small card ("minibox.<lane>") already are, so a reload puts each project
// back on the view it was left on rather than on another project's view. only
// the four names below are ever written or believed: anything else found in
// storage counts as no choice at all, and so does anything a lane id borrowed
// from the record's own object (a lane may legitimately be called "constructor"):
// every answer is checked against the four before it is given.
const TICKET_VIEWS = ["todo", "docked", "deferred", "done"];
function ticketPageOf(view){ return view === "deferred" || view === "done" ? 1 : 0; }
// the section a step of 1 or -1 from view lands on, in the order the four are
// drawn; null past either end, since the list does not wrap
function adjacentTicketView(view, step){
  return TICKET_VIEWS[TICKET_VIEWS.indexOf(view) + step] || null;
}
let tikNamesOwner = null, tikNamesView = null, tikNamesPage = 0, tikNamesReturn = null;
function cancelTicketNamesReturn(){
  clearTimeout(tikNamesReturn);
  tikNamesReturn = null;
}
// A name selection commits a list. Paging the names never does.
function chooseTicketNames(view){
  cancelTicketNamesReturn();
  tikNamesOwner = activeOwner;
  tikNamesView = view;
  tikNamesPage = ticketPageOf(view);
}
function slideTicketNames(page){
  paintViewTabs();
  const arrow = document.getElementById(page ? "tik-page" : "tik-page-back");
  if (chipOff(arrow)) return;
  cancelTicketNamesReturn();
  tikNamesPage = page;
  paintViewTabs();
  if (tikNamesPage === 1){
    const owner = activeOwner;
    tikNamesReturn = setTimeout(() => {
      tikNamesReturn = null;
      if (activeOwner !== owner) return;
      tikNamesPage = 0;
      paintViewTabs();
    }, 30000);
  }
}
const TICKET_VIEW_KEY = "tikview.";   // + the lane's own id, which is never parsed back out
const ticketViews = {};               // lane id -> the view chosen for it
let ticketViewRevision = 0;           // an explicit list choice cancels a send's pending follow
function ticketViewOf(owner){
  if (!owner) return TICKET_VIEWS[0];
  let view = ticketViews[owner];
  if (!TICKET_VIEWS.includes(view)){
    try { view = localStorage.getItem(TICKET_VIEW_KEY + owner); } catch (err) { view = null; }
    view = TICKET_VIEWS.includes(view) ? view : TICKET_VIEWS[0];
    ticketViews[owner] = view;
  }
  return view;
}
// one lane's choice, refused unless it is one of the four views
function setTicketViewOf(owner, view){
  if (!owner || !TICKET_VIEWS.includes(view)) return false;
  ticketViewRevision++;
  ticketViews[owner] = view;
  try { localStorage.setItem(TICKET_VIEW_KEY + owner, view); } catch (err) {}
  return true;
}
// the view of the project being looked at. everything that draws or walks the
// list reads it here, so a tab switch needs nothing carried across: the answer
// changes with the lane on its own
function curView(){ return ticketViewOf(activeOwner); }
// Polls keep the independently paged names where they are. A different project
// or list reveals its selected name; only a name click cancels an idle return
// when the same list was already selected.
function paintViewTabs(){
  const view = curView();
  if (tikNamesOwner !== activeOwner || tikNamesView !== view) chooseTicketNames(view);
  const page = tikNamesPage;
  for (const name of TICKET_VIEWS){
    const b = document.getElementById("tv-" + name);
    if (b){
      b.classList.toggle("on", name === view);
      b.inert = ticketPageOf(name) !== page;
      b.setAttribute("aria-hidden", String(b.inert));
    }
  }
  const labels = document.getElementById("tiklabels");
  if (labels) labels.style.transform = "translateX(" + (-page * 100) + "%)";
  for (const [id, target] of [["tik-page-back", 0], ["tik-page", 1]]){
    const arrow = document.getElementById(id);
    if (!arrow) continue;
    const off = page === target;
    if (off) arrow.setAttribute("aria-disabled", "true");
    else arrow.removeAttribute("aria-disabled");
    arrow.tabIndex = off ? -1 : 0;
  }
}
// doing, docked, deferred and done are four adjacent sections of one horizontal sheet
// under the fixed, clipped well: section i rests at translateX(-i*100%). Pressing
// a tab to the right moves the sheet left so the next section enters from the
// right, pressing one to the left reverses it, and a two-section jump travels
// visibly across the middle section. Only #tiksheet moves; the labels, the pill
// and the well hold still. A poll, a project change and the first render place
// the sheet with no motion (moveTicketSheet(view, false)), and reduced motion
// jumps too; only a tab press animates. A press reads the sheet's live position
// and redirects from exactly there, so a reversal mid-travel never resets.
const TIK_TRAVEL_PER = 0.24, TIK_TRAVEL_MAX = 0.62;   // seconds per section, and the cap
const TIK_EASE = "cubic-bezier(.42,.06,.38,1)";       // the board's --gentle
let tikSheetAnim = null;
let tikShownView = null;      // the section the sheet rests at or is travelling to
let tikTravelIntent = null;   // set while a tab press commits, so a render does not jump the sheet

// the sheet's live translateX in sections (1 == one section to the left), read
// off the composited transform so a redirect begins where the eye sees it
function tikSheetSection(sheet){
  const t = getComputedStyle(sheet).transform;
  const m = t && t.match(/matrix\(([^)]+)\)/);
  if (!m) return 0;
  const tx = parseFloat(m[1].split(",")[4]) || 0;
  const w = sheet.getBoundingClientRect().width || 1;
  return -tx / w;
}
function moveTicketSheet(view, animate){
  const sheet = document.getElementById("tiksheet");
  if (!sheet) return;
  const i = Math.max(0, TICKET_VIEWS.indexOf(view));
  const targetPct = -i * 100;
  const reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!animate || reduce || typeof sheet.animate !== "function"){
    if (tikSheetAnim){ tikSheetAnim.cancel(); tikSheetAnim = null; }
    sheet.style.transform = "translateX(" + targetPct + "%)";
    tikShownView = view;
    return;
  }
  const fromPct = -tikSheetSection(sheet) * 100;   // live, before the cancel below
  if (tikSheetAnim) tikSheetAnim.cancel();
  sheet.style.transform = "translateX(" + targetPct + "%)";   // the resting state after the run
  const dist = Math.abs(i - (-fromPct / 100)) || 1;
  const dur = Math.min(TIK_TRAVEL_MAX, TIK_TRAVEL_PER * dist) * 1000;
  tikSheetAnim = sheet.animate(
    [{ transform: "translateX(" + fromPct + "%)" }, { transform: "translateX(" + targetPct + "%)" }],
    { duration: dur, easing: TIK_EASE });
  tikSheetAnim.addEventListener("finish", () => { tikSheetAnim = null; });
  tikShownView = view;
}
// the doing, docked, deferred and done sections filter the lane's pool. the arrow keys
// walk the current section's set, and each pane is drawn from its own section, so
// the four are computed by view rather than off the one current read
function viewFilterFor(b, view){
  const s = cardState(b);
  return view === "done" ? s === "done"
       : view === "deferred" ? s === "parked"
       : view === "docked" ? !!b.docked && s !== "done" && s !== "parked"
       : (!b.docked && s !== "done" && s !== "parked");
}
function viewFilter(b){ return viewFilterFor(b, curView()); }
// the one section a card stands in, read off the very filter the four sections
// are drawn from, so a card's chips can never name a section its tab disagrees
// with. done outranks parked there, so a card the board holds both ways is done
function cardSection(b){ return TICKET_VIEWS.find(view => viewFilterFor(b, view)); }
function viewPoolFor(state, view){ return poolOf(state).filter(b => viewFilterFor(b, view)); }
function viewPool(state){ return viewPoolFor(state, curView()); }

// A reply returns a docked card to Doing. Keep the open card and its list
// together, but only after delivery AND a reading that shows the move. Until
// then the old list still contains the card. A different card, project or
// chosen list cancels the follow; merely paging the names does not.
let sentViewFollow = null;
function captureSentView(id){
  const b = lastState?.boxes.find(x => x.id === id);
  const owner = activeOwner, revision = ticketViewRevision;
  const eligible = selectedId === id && b?.owner === owner &&
    curView() === "docked" && cardSection(b) === "docked";
  // This callback is transient, including on a phone operation: JSON storage
  // omits functions, so a receipt after a reload cannot revive a view change.
  return () => {
    if (eligible && selectedId === id && activeOwner === owner &&
        ticketViewRevision === revision){
      sentViewFollow = { id, owner, revision };
      // A reading can beat its send's acknowledgement. Ask the page to draw
      // that already-known move now instead of waiting for another poll.
      const current = lastState?.boxes.find(x => x.id === id);
      return !!current && cardSection(current) === "todo";
    }
    return false;
  };
}
function syncSentView(state){
  const follow = sentViewFollow;
  if (!follow) return null;
  const b = state.boxes.find(x => x.id === follow.id);
  if (selectedId !== follow.id || activeOwner !== follow.owner ||
      ticketViewRevision !== follow.revision || !b || b.owner !== follow.owner){
    sentViewFollow = null;
    return null;
  }
  const section = cardSection(b);
  if (section === "docked") return null;
  sentViewFollow = null;
  if (section !== "todo") return null;
  setTicketViewOf(follow.owner, section);
  return follow.id;
}

// when a card became the reader's turn. agentTs is written as the turn goes back
// to the reader; a card the agent never answered ages by its own ts; one with
// neither stamp cannot be aged and counts as the newest
function waitingSince(b){ return b.agentTs || b.ts || Number.MAX_SAFE_INTEGER; }

// when the board put a card in the section it stands in. a card with no stamp
// yet is one this page has just moved there, ahead of the board's reading, so it
// counts as the most recent
function restedSince(b, field){ return b[field] || Number.MAX_SAFE_INTEGER; }

function poolOf(state){
  const keep = poolScope ? poolScope(state) : null;
  const legacy = (a, b, newest) => {
    // an untouched new card stays on top; the first send drops it into the
    // waiting group; anything green (in progress) sinks below all of that
    const g = x => ({ "new": 0, yours: 1, queued: 2, working: 3, done: 4 })[queueState(x)];
    if (g(a) !== g(b)) return g(a) - g(b);
    if (g(a) === 0) return (b.ts || 0) - (a.ts || 0);   // newest created on top
    // the waiting group is a queue: oldest turn first, so old turns do not go
    // stale below newer ones. this is the same measure the post-send jump uses
    // to pick the longest-waiting card; equal stamps keep the board's order.
    // the reader may choose newest turn first instead (waitNewestFirst), which
    // turns only this comparison over: the jump does not read it, and the other
    // sections reach here with newest false, so they keep their fallback order
    if (g(a) === 1) return newest ? waitingSince(b) - waitingSince(a) : waitingSince(a) - waitingSince(b);
    return (b.ts || 0) - (a.ts || 0);                    // queued and working: newest first
  };
  // the four sections lie one after another: doing, docked, deferred, done. doing keeps
  // the order above; other sections run by when each card entered them, most
  // recent first, and cards with equal stamps
  // fall back to the order above
  const part = x => { const s = cardState(x); return s === "done" ? 3 : s === "parked" ? 2 : x.docked ? 1 : 0; };
  const stamp = { 1: "dockedTs", 2: "parkedTs", 3: "doneTs" };
  const newest = !!waitNewestFirst();
  return state.boxes.filter(b =>
    b.owner === activeOwner && b.id !== "q" && (!keep || keep(b)))
    .sort((a, b) => {
      const pa = part(a), pb = part(b);
      if (pa !== pb) return pa - pb;
      if (pa) return restedSince(b, stamp[pa]) - restedSince(a, stamp[pa]) || legacy(a, b);
      return legacy(a, b, newest);
    });
}

// ---- the lanes ------------------------------------------------------------------
// project rows in fixed order: tool meta on top, the rest as the board lists them
function allRowsOf(state){
  const owners = [];
  for (const b of state.boxes)
    if (b.owner !== "qchat" && !owners.includes(b.owner)) owners.push(b.owner);   // the quick chat lane never gets a tab
  // stored project lanes keep their tab even with every card deleted
  for (const p of (state.projects || []))
    if (!owners.includes(p.id)) owners.push(p.id);
  owners.sort((a, b) => (a === "facilitator" ? -1 : b === "facilitator" ? 1 : 0));
  // a dragged tab order outlives reloads, server restarts and the device it
  // was dragged on: saved lanes lead in their saved sequence, lanes the record
  // does not know keep the natural order after them, and stale saved ids must
  // never throw
  const saved = tabRecord(state).order;
  const lead = saved.filter(ow => owners.includes(ow));
  return [...lead, ...owners.filter(ow => !lead.includes(ow))];
}

// ---- the tab bar's record ---------------------------------------------------------
// which lanes the bar shows and in what order is the board's own record, kept
// on the server and handed out with the state, so the desktop and the phone
// draw one bar and either of them may reorder it. an empty order is a board
// that has never had an arrangement written, and both pages then fall back to
// the natural lane order they always used.
const TAB_HOLD = 3000;   // ms a page's own write outranks a poll already in flight
let tabsHeld = null;     // {rec, until}: this page's write, until a poll carries it back
function tabRecord(state){
  const rec = (state && state.tabs) || {};
  const now = {
    order: Array.isArray(rec.order) ? rec.order : [],
    closed: Array.isArray(rec.closed) ? rec.closed : [],
  };
  // a poll that left before this page's write must not undo it; once the
  // record agrees, or the hold runs out, the server's answer is the truth
  if (tabsHeld && Date.now() < tabsHeld.until &&
      JSON.stringify(now) !== JSON.stringify(tabsHeld.rec)) return tabsHeld.rec;
  return now;
}
function tabShut(state, ow){ return tabRecord(state).closed.includes(ow); }
// one write, the whole record at once, so a reorder can never half land. what
// the server answers is what the page keeps, never the copy it sent
function writeTabs(rec){
  const clean = { order: (rec.order || []).slice(), closed: (rec.closed || []).slice() };
  tabsHeld = { rec: clean, until: Date.now() + TAB_HOLD };
  return fetch("/tabs", { method: "POST", body: JSON.stringify(clean) })
    .then(r => r.json())
    .then(r => { if (r && r.tabs) tabsHeld = { rec: r.tabs, until: Date.now() + TAB_HOLD }; })
    .catch(() => {});
}
function labelOf(state, owner){
  const dir = (state.pwds || {})[owner] || "";
  return dir.split("/").filter(Boolean).pop() || owner;
}

// ---- "Open a new folder" ------------------------------------------------------------
// the board's own folder picker (folder-picker.js) and its sheet, fetched the
// first time a folder is asked for and never on boot. the picker waits for
// both, so nothing of it is drawn unstyled. answers whether it loaded: a
// server from before their routes answers 404, and the page says a restart is
// needed. a load that failed is tried afresh on the next ask
let folderPickerLoad = null;
function folderPickerBundle(){
  if (globalThis.FolderPicker && document.getElementById("fpsheet")?.sheet) return Promise.resolve(true);
  if (folderPickerLoad) return folderPickerLoad;
  folderPickerLoad = new Promise(res => {
    let left = 2, good = true;
    const done = ok => {
      good = good && ok;
      if (--left) return;
      if (!good || !globalThis.FolderPicker) folderPickerLoad = null;
      res(good && !!globalThis.FolderPicker);
    };
    let sheet = document.getElementById("fpsheet");
    if (sheet?.sheet) done(true);
    else {
      if (!sheet){
        sheet = document.createElement("link");
        sheet.id = "fpsheet"; sheet.rel = "stylesheet"; sheet.href = "/folder-picker.css";
        document.head.append(sheet);
      }
      sheet.addEventListener("load", () => done(true), { once: true });
      sheet.addEventListener("error", () => { sheet.remove(); done(false); }, { once: true });
    }
    if (globalThis.FolderPicker){ done(true); return; }
    const s = document.createElement("script");
    s.src = "/folder-picker.js";
    s.onload = () => done(true);
    s.onerror = () => { s.remove(); done(false); };
    document.head.append(s);
  });
  return folderPickerLoad;
}
// the words a refused project is named with, the same on the board and the
// phone: the server states its refusal and these repeat it in plain words. a
// duplicate answer with no visible tab of that name means the id collides with
// a reserved internal lane: older servers refuse those, so the words must not
// claim the folder is already open
function projectRefusal(pr, st, name){
  let msg = { "body must be a folder under home": "that folder is outside your home folder",
              "empty name": "that folder has no usable name" }[pr?.error]
          || "could not create that project";
  if (pr?.error === "duplicate project"){
    const named = st && allRowsOf(st).some(ow => labelOf(st, ow) === name);
    msg = named ? "a project named " + name + " is already open"
                : "that name is reserved right now, the folder can be added after the next server restart";
  }
  return msg;
}

// which replies the owner has laid eyes on: box id -> how many replies the
// card carried when it was last opened; selecting a card counts as reading the
// reply it shows. the board keeps this, one record per card, so a card opened
// on the phone counts as read on the desktop too. the map below is this page's
// copy of what the state last said, with its own writes held on top of it
const SEEN_HOLD = 3000;   // ms a page's own write outranks a poll already in flight
const seenReplies = {};
const seenHeld = {};      // id -> {n, until}: this page's write, until a poll carries it back
const seenTotals = {};    // id -> the replies the card carried at the last sync
function seenSync(state){
  const now = Date.now();
  for (const b of (state.boxes || [])){
    const said = b.seen || 0;
    const held = seenHeld[b.id];
    if (held && (said >= held.n || now >= held.until)) delete seenHeld[b.id];
    seenReplies[b.id] = seenHeld[b.id] ? Math.max(said, seenHeld[b.id].n) : said;
    seenTotals[b.id] = b.replies || 0;
  }
}
// these cards are read now, up to the replies they are showing: the page marks
// them at once and the board is told in one write, so the other device sees it
// on its next poll. a mark that would lower a count is dropped, never sent
function setSeenMany(marks){
  const send = {};
  for (const id of Object.keys(marks)){
    const n = marks[id];
    if (!(n > 0) || (seenReplies[id] || 0) >= n) continue;
    seenReplies[id] = n;
    seenHeld[id] = { n: n, until: Date.now() + SEEN_HOLD };
    send[id] = n;
  }
  if (!Object.keys(send).length) return Promise.resolve();
  return fetch("/seen", { method: "POST", body: JSON.stringify(send) })
    .then(r => r.json())
    .then(r => {
      for (const [id, n] of Object.entries((r && r.seen) || {})){
        if (typeof n !== "number") continue;
        seenReplies[id] = n;
        seenHeld[id] = { n: n, until: Date.now() + SEEN_HOLD };
      }
    })
    .catch(() => {});
}
function markSeen(id){
  if (globalThis.macPhoneInactive) return;
  if (seenTotals[id] != null) setSeenMany({ [id]: seenTotals[id] });
}
// a click into a card's composer, or a key typed there, is using the card, so
// it counts as read. use is the page's own way of saying so, markSeen unless
// the page does more. the input is asked about the caret, because the
// formatter also says input when it puts its editor on or takes it off, which
// it does to every card on load, and that is nobody reading anything
function readOnCompose(ta, id, use = markSeen){
  ta.addEventListener("focus", () => use(id));
  ta.addEventListener("input", () => { if (ComposeFormat.focused(ta)) use(id); });
}
// a reply that lands on the card the reader has selected, while the page is
// on screen and its window is in front, is read the moment it lands. inUse is
// the page's word that this is the card being used. a window behind another
// app leaves the reply unread until the reader comes back and uses the card.
// el.replyCount is the count this page last drew, so a first drawing or a
// reload has nothing to compare with and marks nothing. called after
// seenSync, so the mark covers the reply that just came
function readOnArrival(el, b, inUse){
  const was = el.replyCount, now = b.replies || 0;
  el.replyCount = now;
  if (was == null || now <= was || !inUse) return false;
  if (document.visibilityState !== "visible" || !document.hasFocus()) return false;
  markSeen(b.id);
  return true;
}

// does this lane still hold a reply the reader has not opened? this is the left
// list's own seen test, card by card, so the tab and the row can never
// disagree about what unread means: the agent has answered, the ball is with
// the reader, nothing of the reader's is still queued behind it, and the reader has not opened the
// card since that answer landed. cardState keeps done and deferred cards out,
// so a lane the reader has finished with never asks again
function laneUnread(state, owner){
  return !!state && state.boxes.some(b =>
    b.owner === owner && b.id !== "q" && cardState(b) === "yours" &&
    (seenReplies[b.id] || 0) < (b.replies || 0));
}

function pickInRow(state, owner){
  const row = state.boxes.filter(b => b.owner === owner && b.id !== "q");
  if (!row.length) return null;
  return (lastSel[owner] && row.find(b => b.id === lastSel[owner]))
      || row.find(awaitsYou)
      || row[0];
}

// ---- resizing a box on the board --------------------------------------------------
// the smallest and largest a box may be dragged to, in whole grid cells (one
// cell is a step, 5.76 stage pixels, half the star pitch; the stage is 250 by
// 156 cells). the conversation card starts at 90 by 133, the ticket list at 63
// by 89, the spotify box at about 49 by 22 and the clock at 38 by 18 (the
// layout mock's, m1330). a box not named here keeps the plain four-cell floor
// and no ceiling. these are starting numbers, meant to be tuned, and the same
// sizes they were in the old 11.52 cells, so every one is the old number doubled
const RESIZE_LIMITS = {
  main:     { minW: 60, maxW: 140, minH: 80, maxH: 152 },   // the conversation card
  tickets:  { minW: 44, maxW: 92,  minH: 32, maxH: 126 },   // no taller than the card starts
  magic1:   { minW: 32, maxW: 80,  minH: 16, maxH: 48 },    // the spotify box
  clockbox: { minW: 28, maxW: 68,  minH: 14, maxH: 32 },
};
// one step of an edge-handle drag, as pure arithmetic: s is the box when the
// grab began (left, top, w, h and the snapped far edges right and bottom, all
// in stage pixels), dir the handle ("nw", "e" and so on), dx and dy the pull.
// sizes stay whole cells; a west or north pull moves the origin to a star line
// and keeps the far edge pinned. only the axes the handle pulls are held to the
// limits, so a saved size outside them stays put until that edge is dragged.
// the star lines are whole cells counted from the first one, a cell in from
// the stage's edge, as onStar in index.html counts them
function clampResize(s, dir, dx, dy, grid, lim){
  const onStar = v => Math.round((v - grid) / grid) * grid + grid;
  const floor = 4 * grid;
  const minW = Math.max(floor, lim ? lim.minW * grid : 0), maxW = lim ? lim.maxW * grid : Infinity;
  const minH = Math.max(floor, lim ? lim.minH * grid : 0), maxH = lim ? lim.maxH * grid : Infinity;
  const out = {};
  let w = Math.max(floor, Math.round(s.w / grid) * grid);
  let h = Math.max(floor, Math.round(s.h / grid) * grid);
  if (dir.includes("e")) w = Math.min(maxW, Math.max(minW, Math.round((s.w + dx) / grid) * grid));
  if (dir.includes("s")) h = Math.min(maxH, Math.max(minH, Math.round((s.h + dy) / grid) * grid));
  if (dir.includes("w")){
    out.left = Math.min(Math.max(grid, s.right - maxW, onStar(s.left + dx)), s.right - minW);
    w = s.right - out.left;
  }
  if (dir.includes("n")){
    out.top = Math.min(Math.max(grid, s.bottom - maxH, onStar(s.top + dy)), s.bottom - minH);
    h = s.bottom - out.top;
  }
  out.w = w; out.h = h;
  return out;
}

// ---- times ------------------------------------------------------------------------
const MONTHS3 = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// the stamp on a sent-and-waiting message: a short clock time, plus a plain
// month-and-day date in front only when the send was not today; empty when
// the send time is unknown (entries queued before the server recorded times)
function stampText(ts){
  if (!ts) return "";
  const d = new Date(ts * 1000);
  if (isNaN(d.getTime())) return "";
  const hr = d.getHours();
  const clock = (hr % 12 || 12) + ":" + String(d.getMinutes()).padStart(2, "0") + " " + (hr < 12 ? "AM" : "PM");
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return clock;
  const day = MONTHS3[d.getMonth()] + " " + d.getDate() + (d.getFullYear() === now.getFullYear() ? "" : " " + d.getFullYear());
  return day + ", " + clock;
}

function shortAge(ts){
  if (!ts) return "";
  const sec = Date.now() / 1000 - ts;
  if (sec < 60) return "now";
  if (sec < 3600) return Math.floor(sec / 60) + "m";
  if (sec < 86400) return Math.floor(sec / 3600) + "h";
  return Math.floor(sec / 86400) + "d";
}

// the time on a ticket, for the desktop list and the phone list alike. an open
// ticket counts from the last message on the card, whoever sent it: the reader's
// last (sent, still queued, or already answered) or the agent's last reply,
// whichever is newer, so a new card with only the reader's message has a time
// from the moment it was sent. a done ticket keeps counting from the agent's
// last reply, as it has since the age was added to it
function ticketTs(b){
  if (b.done) return b.agentTs || 0;
  let at = b.agentTs || 0;
  for (const ts of b.pendingStamps || []) if (ts > at) at = ts;
  for (const m of b.answered || []) if (m && m.ts > at) at = m.ts;
  return at;
}

// ---- the card's row ---------------------------------------------------------------
function attachmentNotice(ta, text){
  const parent = ta.closest(".pendwrap") || ta.closest(".c3bar") || ta.parentElement;
  let note = parent.querySelector(".attachment-status");
  if (!note){
    note = document.createElement("div");
    note.className = "attachment-status";
    note.setAttribute("role", "status");
    parent.appendChild(note);
  }
  note.textContent = text;
}

async function uploadAttachment(file){
  const info = CardMarkdown.attachmentFile(file);
  if (info.error) throw new Error(info.error);
  const response = await fetch("/upload?name=" + encodeURIComponent(info.name), { method: "POST", body: file });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.url) throw new Error(result?.error || "Upload failed. Please try again.");
  return result.url;
}

async function attach(files, ta){
  ta.attachmentPending = (ta.attachmentPending || 0) + 1;
  try {
    const errors = [];
    for (const file of files){
      try {
        const url = await uploadAttachment(file);
        const start = ta.selectionStart, end = ta.selectionEnd, direction = ta.selectionDirection;
        ta.value += (ta.value && !ta.value.endsWith("\n") ? "\n" : "") + url + "\n";
        ta.setSelectionRange(start, end, direction);
        const field = globalThis.ComposeFormat?.fieldOf(ta);
        if (field) field.changed();
        else ta.dispatchEvent(new Event("input"));
      } catch (error){
        errors.push((file.name || "Attachment") + ": " + (error.message || "Upload failed. Please try again."));
      }
    }
    attachmentNotice(ta, errors.join("\n"));
  } finally { ta.attachmentPending--; }
}

function wireAttachmentTransfer(ta, pick = files => attach(files, ta)){
  ta.addEventListener("dragover", event => {
    if (![...(event.dataTransfer?.types || [])].includes("Files")) return;
    event.preventDefault(); ta.classList.add("dropping");
  });
  ta.addEventListener("dragleave", () => ta.classList.remove("dropping"));
  for (const type of ["drop", "paste"]){
    ta.addEventListener(type, event => {
      const data = type === "drop" ? event.dataTransfer : event.clipboardData;
      const files = [...(data?.files || [])];
      if (!files.length) return;
      event.preventDefault(); ta.classList.remove("dropping");
      pick(files);
    }, true);
  }
}

// ---- the files picked for the next message ---------------------------------------
// a picked file goes into the tray over the typing row at once, as a square that
// stands from the tap, and starts uploading while the words are typed, one file
// at a time in the order they were picked. the square carries the state alone,
// with no words anywhere: the upload's ring while it goes, and a red mark when
// it did not. a file the board refuses wears the mark and is not tried again;
// one that did not get through is tried again on its own a few times, then wears
// the mark and waits for a tap. the message carries
// the files the way the board keeps them, as /uploads lines ahead of the words,
// and a send pressed while a file is still on its way waits for it in the row:
// nothing goes without its files, and nothing leaves the row before it can go.
// the tray moves on one beat, 400ms on a curve that leaves fast and settles
// slowly: a square slides a short way in from the left as it arrives, one taken
// out shrinks and fades while the rest close the gap, and the tray eases shut
// under the last one.
// a try that did not get through, which says nothing about the file, is tried
// again on its own, on the same backoff the messages use, a few times, and at
// once when the app comes back to the screen or back online. before a file is
// sent again the board is asked whether the last try landed after all, under
// the file's operation id, so a reply lost on the way never costs the whole
// file again, and never leaves a second copy on the board. the phone and the
// desktop board draw and run it from here, each on its own card's row
const TRAY_TRIES = 5;                 // tries in a round before the file waits for a tap
const TRAY_QUIET_MS = 75000;          // no progress this long and the try is given up
const TRAY_MS = 400;
const TRAY_EASE = "cubic-bezier(.22,1,.36,1)";
const TRAY_SLIDE_PX = 18;             // a short hop beside a 64px square, with no visible origin
const TRAY_PREVIEW_PX = 192;          // a picture's preview width: sharp at 3x in a 64px square
const TRAY_RING = 65.97;              // the ring's length, twice pi times its 10.5px radius
const TRAY_REFUSED = new Set([400, 401, 403, 413, 415]);   // the board decided about this file
const TRAY_X = '<svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true"><path d="M1 1l6 6M7 1L1 7" ' +
  'stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

function trayBeat(){
  const calm = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  return { duration: calm ? 0 : TRAY_MS, easing: TRAY_EASE };
}
function trayMoving(it){ return it.state === "up" || it.state === "queued" || it.state === "wait"; }
function trayBusy(el){ return !!el && el.trayItems.some(trayMoving); }
// something in the tray can go with a message: uploaded, or still on its way
function traySendable(el){ return !!el && el.trayItems.some(it => it.state === "done" || trayMoving(it)); }
// sizes the way the phone's own Files app writes them: KB under a megabyte
function traySize(bytes){
  return bytes < 1e6 ? Math.max(bytes ? 1 : 0, Math.round(bytes / 1e3)) + " KB" : (bytes / 1e6).toFixed(1) + " MB";
}

function trayAdd(id, files){
  const el = els[id];
  if (!el || !files.length) return;
  el.trayCard = id;
  trayListen();
  trayOpen(el);
  for (const file of files){
    const info = CardMarkdown.attachmentFile(file);
    const it = { key: newOpId(), file, name: info.name, kind: info.kind || "document",
      ext: (info.ext || (/\.([a-z0-9]+)$/i.exec(info.name) || [])[1] || "file").toUpperCase(),
      total: file.size, sent: 0, tries: 0, measured: false, urls: [],
      state: info.error ? "refused" : "queued" };
    el.trayItems.push(it);
    traySquare(el, it);
    it.sq.animate([{ opacity: 0, transform: "translateX(-" + TRAY_SLIDE_PX + "px)" },
                   { opacity: 1, transform: "none" }], trayBeat());
    if (!info.error) trayPreview(it);
  }
  trayDraw(el);
  trayPump(el);
  el.tick();
}

// the uploads this card's tray has held, so a kept draft knows which of its
// files this page has already answered for (draftSave)
function trayHeldNote(el, url){
  if (!el.trayHeld) el.trayHeld = new Set();
  el.trayHeld.add(url);
}
// the files a kept draft held, back in the tray already uploaded. they stand at
// once, with no slide, and wear the board's own copy for their picture
function trayRestore(el, files){
  const back = (files || []).filter(f => !el.trayItems.some(it => it.url === f.url));
  if (!back.length) return;
  trayOpen(el);
  for (const f of back){
    const total = Number(f.total) || 0;
    const it = { key: newOpId(), file: null, name: f.name, kind: f.kind || "document",
      ext: String(f.ext || "file").toUpperCase(), total, sent: total, tries: 0, measured: true,
      urls: [], state: "done", url: f.url };
    el.trayItems.push(it);
    traySquare(el, it);
    trayHeldNote(el, f.url);
    if (it.kind !== "image" && it.kind !== "video") continue;
    let pic;
    if (it.kind === "image"){
      pic = new Image();
      pic.alt = "";
      pic.onload = () => it.sq.classList.add("drawn");
      pic.src = it.url;
    } else {
      pic = document.createElement("video");
      pic.muted = true; pic.playsInline = true; pic.preload = "metadata";
      pic.addEventListener("loadeddata", () => it.sq.classList.add("drawn"), { once: true });
      pic.src = it.url + "#t=" + TRAY_STILL_AT;
    }
    pic.className = "tsqpic";
    pic.setAttribute("aria-hidden", "true");
    it.face.insertBefore(pic, it.veil);
  }
  trayDraw(el);
}

// the tray stands again: a close still running is called off, and whatever it
// was taking away goes at once
function trayOpen(el){
  const tray = el.tray;
  if (el.trayClosing){ const run = el.trayClosing; el.trayClosing = null; run.cancel(); }
  for (const sq of [...tray.querySelectorAll(".tsq")])
    if (!el.trayItems.some(it => it.sq === sq)) sq.remove();
  tray.classList.remove("closing");
  tray.classList.add("on");
}

function traySquare(el, it){
  const sq = h("div", "tsq");
  const face = h("div", "tsqface");
  const kind = h("span", "tsqkind", it.ext);
  kind.appendChild(h("small", "", traySize(it.total)));
  const veil = h("span", "tsqveil");
  const ring = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  ring.setAttribute("class", "tsqring");
  ring.setAttribute("viewBox", "0 0 24 24");
  ring.setAttribute("aria-hidden", "true");
  ring.innerHTML = '<circle class="track" cx="12" cy="12" r="10.5"/><circle class="arc" cx="12" cy="12" r="10.5"/>';
  const bang = h("span", "tsqbang", "!");
  bang.setAttribute("aria-hidden", "true");
  face.append(kind, veil, ring, bang);
  const x = h("button", "tsqx");
  x.type = "button"; x.setAttribute("aria-label", "take " + it.name + " out");
  x.innerHTML = TRAY_X;
  sq.append(face, x);
  sq.setAttribute("role", "img");
  // a tap inside the row keeps the keyboard where it is, as the plus does
  x.addEventListener("pointerdown", e => { if (ComposeFormat.focused(el.ta)) e.preventDefault(); });
  x.addEventListener("click", e => { e.stopPropagation(); trayRemove(el, it); });
  face.addEventListener("click", () => trayRetry(el, it));
  Object.assign(it, { sq, face, veil, arc: ring.querySelector(".arc") });
  el.tray.appendChild(sq);
}

// the picture a square wears: a photo decoded small on the side where the
// engine can, which is a fraction of the work of the whole photo, else the
// photo itself; a video's first frame; anything else keeps its kind and size
async function trayPreview(it){
  if (it.kind !== "image" && it.kind !== "video") return;
  let pic;
  if (it.kind === "image"){
    let url = null;
    try {
      if (typeof createImageBitmap === "function"){
        const bitmap = await createImageBitmap(it.file, { resizeWidth: TRAY_PREVIEW_PX, resizeQuality: "medium" });
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width; canvas.height = bitmap.height;
        canvas.getContext("2d").drawImage(bitmap, 0, 0);
        if (bitmap.close) bitmap.close();
        const blob = await new Promise(resolve => canvas.toBlob(resolve));
        if (blob) url = URL.createObjectURL(blob);
      }
    } catch (e) {}   // this engine cannot draw this file small: the whole file then
    if (it.gone){ if (url) URL.revokeObjectURL(url); return; }
    if (!url) url = URL.createObjectURL(it.file);
    it.urls.push(url);
    pic = new Image();
    pic.alt = "";
    pic.onload = () => { it.sq.classList.add("drawn"); trayStill(it); };
    pic.src = url;
  } else {
    const url = URL.createObjectURL(it.file);
    it.urls.push(url);
    pic = document.createElement("video");
    pic.muted = true; pic.playsInline = true; pic.preload = "metadata";
    pic.addEventListener("loadeddata", () => { it.sq.classList.add("drawn"); trayStill(it, pic); }, { once: true });
    pic.src = url + "#t=" + TRAY_STILL_AT;
  }
  pic.className = "tsqpic";
  pic.setAttribute("aria-hidden", "true");
  it.face.insertBefore(pic, it.veil);
}

// what the sent bubble a file goes into shows of it until the board's copy has
// come back (sentStills, below), so the bubble has its picture from its first
// frame and nothing has to come back from the board first: a picture's own
// file, and the frame a video's square drew, kept as a still at the width a
// bubble shows it at, so it is the picture the square wore. each is decoded
// before anything wears it, which is what lets the bubble, and the flight's
// copy of it, have the picture in the very task they are drawn in. neither is
// among the urls the tray lets go
const TRAY_STILL_AT = 0.1;            // seconds in: the frame the square's player is sent to
const TRAY_STILL_PX = 960;            // sharp at 3x in the widest bubble
function trayStill(it, video){
  if (!video){ trayKeep(it, URL.createObjectURL(it.file)); return; }
  const width = video.videoWidth, height = video.videoHeight;
  if (!width || !height) return;
  const k = Math.min(1, TRAY_STILL_PX / width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * k); canvas.height = Math.round(height * k);
  try { canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height); }
  catch (e) { return; }   // this engine cannot draw this player: the bubble waits for the board
  canvas.toBlob(blob => { if (blob) trayKeep(it, URL.createObjectURL(blob), width, height); }, "image/jpeg", .85);
}
function trayKeep(it, url, width, height){
  const img = new Image();
  img.src = url;
  const keep = () => {
    // an engine that cannot draw the file: the bubble waits for the board's copy
    if (!img.naturalWidth){ URL.revokeObjectURL(url); return; }
    it.still = { url, width: width || img.naturalWidth, height: height || img.naturalHeight, img };
    sentStillFor(it);
  };
  (img.decode ? img.decode() : Promise.resolve()).then(keep, keep);
}

// one upload at a time per card, in the order the files were picked
function trayPump(el){
  if (el.trayItems.some(it => it.state === "up")) return;
  const next = el.trayItems.find(it => it.state === "queued");
  if (next) trayUpload(el, next);
}

function trayUpload(el, it){
  it.state = "up"; it.sent = 0; it.measured = false; it.tries++;
  if (it.posted) trayAsk(el, it);
  else trayPost(el, it);
}

// the board is asked whether the file's last try landed after all: its
// receipt answers with the stored file, and only a board with no record of it
// is sent the file again
async function trayAsk(el, it){
  trayDraw(el);
  let answer = null, body = null;
  try {
    answer = await fetch("/upload?op=" + encodeURIComponent(it.key), { signal: AbortSignal.timeout(8000) });
    body = await answer.json();
  } catch (e) {}
  if (it.gone || it.state !== "up" || it.xhr) return;
  if (answer && answer.ok && body && body.url) trayLanded(el, it, 200, body);
  else if (answer && answer.ok && body && body.arriving) trayLanded(el, it, 409, null);
  else if (answer && answer.status === 404) trayPost(el, it);
  else trayLanded(el, it, answer ? answer.status : 0, body);
}

// an XMLHttpRequest and not a fetch: it is the one way a page can hear how
// much of a body has gone. the operation id names this file's upload, so the
// board can tell a second try of it from a new file. once progress has been
// heard, a try that hears none for TRAY_QUIET_MS is given up, since a link can
// die without either end being told
function trayPost(el, it){
  const xhr = new XMLHttpRequest();
  it.xhr = xhr;
  it.posted = true;
  xhr.open("POST", "/upload?name=" + encodeURIComponent(it.name) + "&op=" + encodeURIComponent(it.key));
  const landed = (status, body) => {
    if (it.xhr !== xhr) return;
    it.xhr = null;
    clearTimeout(it.quiet);
    trayLanded(el, it, status, body);
  };
  xhr.upload.onprogress = e => {
    if (it.xhr !== xhr) return;
    it.sent = e.loaded;
    if (e.lengthComputable && e.total) it.total = e.total;
    it.measured = true;
    clearTimeout(it.quiet);
    it.quiet = setTimeout(() => { if (it.xhr === xhr){ xhr.abort(); landed(0, null); } }, TRAY_QUIET_MS);
    trayDraw(el);
  };
  xhr.onload = () => {
    let body = null;
    try { body = JSON.parse(xhr.responseText); } catch (e) {}
    landed(xhr.status, body);
  };
  xhr.onerror = () => landed(0, null);
  xhr.send(it.file);
  trayDraw(el);
}

// how a try ended: stored; refused for good; or not got through, which says
// nothing about the file and is tried again on the messages' backoff until the
// round's tries are spent, then waits for a tap
function trayLanded(el, it, status, body){
  if (it.gone) return;
  if (status === 200 && body && body.url){
    it.state = "done"; it.url = body.url; it.sent = it.total;
    trayHeldNote(el, it.url);
    sentStillFor(it);
  } else if (TRAY_REFUSED.has(status)){
    it.state = "refused";
  } else {
    if (it.tries < TRAY_TRIES){
      it.state = "wait";
      clearTimeout(it.timer);
      it.timer = setTimeout(() => trayAgain(el, it), backoffMs(it.tries));
    } else it.state = "failed";
  }
  trayDraw(el);
  el.tick();
  // an uploaded file is kept with the words before a held send can take both
  if (it.state === "done") draftSave(draftCardOf(el));
  trayRelease(el);
  trayPump(el);
}
function trayAgain(el, it){
  clearTimeout(it.timer);
  if (it.gone || it.state !== "wait") return;
  it.state = "queued";
  trayDraw(el);
  trayPump(el);
}

// a tap on a file that did not get through starts another round of tries; a
// tap on one waiting out its backoff tries it now
function trayRetry(el, it){
  if (it.gone) return;
  if (it.state === "wait"){ trayAgain(el, it); return; }
  if (it.state !== "failed") return;
  it.state = "queued"; it.tries = 0;
  trayDraw(el);
  el.tick();
  trayPump(el);
}
// the app is on screen again, or the network is back: every file waiting out
// a backoff is tried now, as the messages are
function trayWake(){
  for (const el of Object.values(els))
    for (const it of el.trayItems || []) if (it.state === "wait") trayAgain(el, it);
}
// hung on the first file picked and not before, so a page that never picks one
// (and a sandbox that loads this file bare) carries no listener for it
let trayListening = false;
function trayListen(){
  if (trayListening) return;
  trayListening = true;
  document.addEventListener("visibilitychange", () => { if (!document.hidden) trayWake(); });
  window.addEventListener("pageshow", trayWake);
  window.addEventListener("online", trayWake);
}

// the cross: the file leaves the tray, and an upload of it still going is let go
function trayRemove(el, it){
  if (it.gone) return;
  trayForget(it);
  el.trayItems = el.trayItems.filter(o => o !== it);
  trayLeave(el, [it]);
  trayDraw(el);
  el.tick();
  draftSave(draftCardOf(el));
  trayRelease(el);
  trayPump(el);
}
function trayForget(it){
  it.gone = true;
  clearTimeout(it.timer);
  clearTimeout(it.quiet);
  if (it.xhr){ const xhr = it.xhr; it.xhr = null; xhr.abort(); }
}

// a send pressed while files were still on their way: the words stay in the
// row until the files have landed
function trayHoldSend(id, opts){
  const el = els[id];
  el.trayHold = { advance: opts.advance, wait: new Set(el.trayItems.filter(trayMoving).map(it => it.key)) };
}
// the files a held send waited for have landed: it goes now, or, when one of
// them did not get through, it stays in the row and the square wears its mark
function trayRelease(el){
  const hold = el.trayHold;
  if (!hold) return;
  const waited = el.trayItems.filter(it => hold.wait.has(it.key));
  if (waited.some(trayMoving)) return;
  el.trayHold = null;
  if (waited.some(it => it.state !== "done")) return;
  doSend(el.trayCard, { advance: hold.advance });
}

// the message's text: the pictures on one line and in a paragraph of their
// own, which is what makes two to four of them stand as the card's grid, then
// every other file on a line of its own, then the words
function trayMessage(el, typed){
  const done = el.trayItems.filter(it => it.state === "done");
  const pics = done.filter(it => it.kind === "image").map(it => it.url).join(" ");
  const files = done.filter(it => it.kind !== "image").map(it => it.url).join("\n");
  return [pics, files, typed].filter(Boolean).join("\n\n");
}
// the files that went with a message leave the tray; one that did not upload
// stays, so nothing picked is lost without a word
function trayTake(el){
  const going = el.trayItems.filter(it => it.state === "done");
  if (!going.length) return;
  for (const it of going) trayForget(it);
  el.trayItems = el.trayItems.filter(it => it.state !== "done");
  trayLeave(el, going);
  trayDraw(el);
}

// the leaving squares shrink and fade where they stand. with others staying,
// each leaving one gives up its seat at once and keeps only its picture, and
// the ones after it slide into the room from where they were; with none
// staying, the tray eases its own height shut under them
function trayLeave(el, leaving){
  const tray = el.tray, beat = trayBeat();
  const drop = [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(.8)" }];
  const gone = sq => { for (const url of leaving.find(it => it.sq === sq)?.urls || []) URL.revokeObjectURL(url); sq.remove(); };
  if (!el.trayItems.length){
    const height = tray.offsetHeight;
    const cs = getComputedStyle(tray);
    const pad = parseFloat(cs.paddingTop) || 0, padBottom = parseFloat(cs.paddingBottom) || 0;
    tray.classList.add("closing");
    for (const it of leaving) it.sq.animate(drop, beat);
    const run = tray.animate([{ height: height + "px", paddingTop: pad + "px", paddingBottom: padBottom + "px" },
                              { height: "0px", paddingTop: "0px", paddingBottom: "0px" }], beat);
    el.trayClosing = run;
    const end = () => {
      for (const it of leaving) gone(it.sq);
      if (el.trayClosing !== run) return;
      el.trayClosing = null;
      tray.classList.remove("on", "closing");
    };
    run.finished.then(end, end);
    return;
  }
  const stay = el.trayItems.map(it => it.sq);
  const before = stay.map(sq => sq.getBoundingClientRect());
  const seats = leaving.map(it => it.sq.getBoundingClientRect());
  for (const it of leaving) it.sq.classList.add("leaving");
  const box = tray.getBoundingClientRect();
  leaving.forEach((it, i) => {
    it.sq.style.left = (seats[i].left - box.left) + "px";
    it.sq.style.top = (seats[i].top - box.top) + "px";
  });
  stay.forEach((sq, i) => {
    const after = sq.getBoundingClientRect();
    const dx = before[i].left - after.left, dy = before[i].top - after.top;
    if (Math.abs(dx) > .5 || Math.abs(dy) > .5)
      sq.animate([{ transform: "translate(" + dx + "px," + dy + "px)" }, { transform: "none" }], beat);
  });
  for (const it of leaving){
    const end = () => gone(it.sq);
    it.sq.animate(drop, beat).finished.then(end, end);
  }
}

// every square's dress from its file's state
function trayDraw(el){
  for (const it of el.trayItems){
    for (const state of ["up", "queued", "wait", "done", "failed", "refused"])
      it.sq.classList.toggle(state, it.state === state);
    it.sq.classList.toggle("indet", it.state === "up" && !it.measured);
    it.sq.classList.toggle("tappable", it.state === "failed" || it.state === "wait");
    const measured = it.state === "done" || (it.state === "up" && it.measured);
    it.arc.style.strokeDashoffset = !measured ? ""
      : String(TRAY_RING * (1 - (it.total ? Math.min(1, it.sent / it.total) : 0)));
    it.sq.setAttribute("aria-label", it.name + ": " + trayWords(it));
  }
}
function trayWords(it){
  return it.state === "done" ? "uploaded" : it.state === "refused" ? "not attached" : it.state === "failed" ? "not uploaded"
    : it.state === "wait" ? "waiting to try again" : it.state === "queued" ? "waiting its turn" : "uploading";
}

// a card that has gone takes its tray with it
function trayDrop(el){
  for (const it of el.trayItems){
    trayForget(it);
    for (const url of it.urls) URL.revokeObjectURL(url);
  }
  el.trayItems = [];
  el.trayHold = null;
}

// the pace of a try that did not get through, shared by the rail and the phone's messages
const RETRY_MIN_MS = 1500, RETRY_MAX_MS = 30000;
function backoffMs(tries){ return Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.max(0, tries - 1)) * (0.8 + Math.random() * 0.4); }

// the send square's seat. it is bottom aligned in the row, the way the chat
// panel pins its arrow to the pill's bottom edge so it holds still while the
// box grows, and the margin written here drops it so its middle lands on the
// middle of the last line of type. while the field is at its cap and scrolling,
// the last line on screen is the one it takes, which is the line being written.
// the plus is not seated here: it has left the row for a bar of its own, and
// that bar stands it on the row's own floor, so it holds
// the bottom however many lines the row has grown to. css alone puts it there,
// so a margin written onto it here could only lift it off the floor it keeps.
// scale: the screen's pixels to the row's own, where the page draws it scaled
// (the Mac board's stage), so the row's height on screen is read in the same
// pixels as its lines; a tall row read unscaled pushed the square off the card
function seatSquare(ta, square, scale = 1){
  const cs = getComputedStyle(ta);
  const lh = parseFloat(cs.lineHeight);
  const pt = parseFloat(cs.paddingTop), pb = parseFloat(cs.paddingBottom);
  const hgt = ta.getBoundingClientRect().height / scale;
  if (!lh || !hgt) return;
  const lines = Math.max(1, Math.round((ta.scrollHeight - pt - pb) / lh));
  const foot = ta.scrollHeight > ta.clientHeight + 1 ? hgt - pb : pt + lines * lh;
  const mid = foot - lh / 2;
  square.style.marginBottom = (hgt - mid - square.offsetHeight / 2) + "px";
}

// ---- the messages the answer was given ------------------------------------------
// the plain grey panel between the card's title and the completed answer under
// it. it holds exactly the messages THAT answer was given, which is a fact only
// the board can state: the board notes them at the moment it hands them over,
// keeps the note across the progress notes written on the way, and writes it
// down beside the answer when the answer is recorded. nothing here works it out
// from what happens to stand nearby, so a reply the board recorded nothing for
// shows no panel at all rather than a guess.
//
// the panel is one block and nothing else: no frame around it, no bubble inside
// it, no time and no label. the messages stand in it one under another in the
// order they were sent, with a blank line between one message and the next. a
// batch taller than the panel's preview is shown cut to its first lines, fading
// out over a strip at the panel's foot that carries a small arrow pointing down,
// and a click or a tap anywhere on it opens the whole batch in place, on the old
// answered box's own fold run, with the arrow turning to point up; another cuts
// it back the same way. a batch that fits the preview is simply shown whole,
// with no strip, no arrow and nothing to press. the desktop card, the phone card
// and the small card all build it here and draw it from the one set of rules in
// card-tokens.css, each at its own size. the messages sent and still waiting
// for an answer stand at the foot of the card in this very panel (see the
// messages waiting for a reply, below), so the two read as one thing.

// what the board recorded one reply was given, or nothing when it recorded
// none. an empty list is an answer and not a silence: it says that reply was
// handed nothing, and nothing is then what the card shows. a reply with no
// record at all (one answered before the board kept this) is unknown, and
// unknown is never drawn as a batch of none
function answeredBatch(meta){
  return meta && meta.id && Array.isArray(meta.answered) ? meta.answered : null;
}

// one card out of the state the page is holding
function stateBoxOf(id){
  return (lastState && lastState.boxes && lastState.boxes.find(b => b.id === id)) || null;
}
// the reply a card is showing right now, as the panel reads it. the board
// names the card's last COMPLETED reply and what it was given; replyKind says
// whether that reply is the text standing on the card, so a progress note
// written over it is never presented as an answer of its own and never borrows
// the answer's batch
function liveAnswered(b){
  if (!b || b.replyKind !== "agent" || !b.replyId) return null;
  return { id: b.replyId, answered: Array.isArray(b.answered) ? b.answered : null };
}
// and the same for one page of the history. the entries ride beside the
// replies, one per reply and in the same order, so an older page carries its
// own batch rather than the live card's. a reply written before the board kept
// any of this has no entry, and stays exactly as readable as it always was
// with no batch invented for it
function histAnswered(list, step){
  const meta = list && list.meta;
  const one = meta && meta[list.length - step];
  if (!one || !one.id) return null;
  return { id: one.id, answered: Array.isArray(one.answered) ? one.answered : null };
}

// the panel's one arrow, centred in the strip at the panel's foot. it points
// down at the rest of a cut batch, and the sheet turns it over to point up
// while the batch stands open. a path and not a font glyph, so its weight holds
// at any scale; it is the chevron the old sent box drew, turned over
const ANSWERED_CHEV = '<svg class="answchev" width="11" height="7" viewBox="0 0 11 7"' +
  ' fill="none" aria-hidden="true"><path d="M1 1.35 5.5 5.65 10 1.35" stroke="currentColor"' +
  ' stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// the panel's markup, built here so no surface can drift from another: the cut,
// the column of messages inside it, and the strip at the foot that carries the
// arrow. room is who the surface wants told once the panel has changed its own
// height and stopped: the desktop card re-snaps the answer's lines on it, and
// the small card has nobody to tell
function answeredPanel(room){
  const panel = h("div", "answered");
  panel.innerHTML = '<div class="answclip"><div class="answstack"></div></div>' +
    '<div class="answfoot">' + ANSWERED_CHEV + "</div>";
  panel.setAttribute("role", "group");
  panel.setAttribute("aria-label", "your messages that the reply below answers");
  panel.answRoom = room || null;
  panel.addEventListener("click", e => {
    // a batch shown whole has nothing more to show
    if (!panel.classList.contains("more")) return;
    // a link or a player inside a message keeps its own press, and a press that
    // ends picking out some of the words is a copy rather than a request
    if (e.target && e.target.closest && e.target.closest("a, button, audio, video")) return;
    if (boxHasSelection(panel)) return;
    toggleAnswered(panel);
  });
  // whether a batch runs past the preview can only be read off a panel that is
  // laid out, and a card that is not on screen is not. so it is read again
  // whenever the column of messages changes size: the card coming on screen,
  // the window being resized, a picture in a message landing. the strip comes
  // and goes with the answer, so a change in it is a change in the room
  if (typeof ResizeObserver !== "undefined"){
    panel.answWatch = new ResizeObserver(() => {
      if (fitAnswered(panel) && panel.answRoom) panel.answRoom();
    });
    panel.answWatch.observe(panel.querySelector(".answstack"));
  }
  return panel;
}

// what a press on the panel's arrow does, and the bubble keys with it
// (answeredKey). a batch shown whole has no arrow and nothing more to show. the
// class is the way the run is heading, so a press that catches a run turns it
// round rather than repeating it. true means the panel was opened or cut back
function toggleAnswered(panel){
  if (!panel || !panel.classList.contains("more")) return false;
  openAnswered(panel, !panel.classList.contains("open"));
  return true;
}

// control+shift+w and s: the card's top bubble (el.answ, the messages the reply
// on the card answered) and its bottom one (el.sent, the newest of the bubbles
// still waiting at its foot), each opened or cut back as a press on its arrow
// does. they come from where the section chords may come from; a card with no
// such bubble, or one shown whole, leaves the key alone
function answeredKey(e, el, which){
  const panel = el && (which === "sent" ? el.sent : el.answ);
  if (!panel || !panel.classList.contains("more") || !sectionChordSource(e.target, el)) return false;
  e.preventDefault();
  return toggleAnswered(panel);
}

// the open and the cut back, run the way the old answered box ran its fold,
// which is the card's one fold: the height carries the change, over the sheet's
// --answ-move (the old --pend-move, 330ms) on the card's --gentle curve, with
// the edge clipped as it goes. the far end is measured on the real destination
// before the run starts, so the height the run stops on is the height the sheet
// gives anyway and taking the inline numbers off at the end moves nothing. a
// press that catches a run freezes it where it stands and aims it back from
// there, every run is numbered so a finish that belongs to an interrupted run
// changes nothing, and two ends can finish one: the transition, and a timer
// behind it for a run with nothing to transition. whoever wants to know about
// the room is told once, when the run has landed, and never on a frame of it.
// what the old box also moved, its column of rows sliding onto its seat and
// fading in, is not copied: here the first lines are already on screen when
// the batch is cut, and the words being read are not the thing to move.
// the dissolve at the cut is a strip of the panel's grey drawn once over the
// foot of the cut, and the run only fades it: out as the batch opens, back in as
// it is cut. its strength is held inline where it stood while the far end is
// measured, the way the height is, so a press that catches a run turns the
// fade round from where it stands as well. nothing in a run is a mask, so no
// frame of it has a dissolve to draw again.
// change, when given, is what the caller changes in the panel after the run's
// start is read and before its far end is: a send puts its message into an open
// sent panel as it cuts it back, so the run starts from what was on screen.
// the two ends stay on the panel for the length of the run (answSpan), for a
// page that has to hold one of its own measures still while the panel moves.
//
// cutting back is one motion: the panel's foot comes up, and the answer under
// it with it, on the height's run. the panel rides at the head of the answer's
// own scroller (answView), and the arrow of a batch opened taller than the view
// is reached by scrolling the panel's head up out of sight. from there the
// answer under the panel would rise by all the cut takes, so the scroll goes
// back on every frame of the run by as much as the cut has taken so far
// (followCut), read off the height the frame is drawn at, up to the part of the
// panel that stands above the view: the answer and the panel's foot stay
// exactly where they stand on the screen, the panel's head stays above the view
// until the run ends, and the words in the part of the panel still in sight
// slide down as it shortens. a cut longer than the part hidden above scrolls
// back by the hidden part and no further, and the answer rises by the rest. a
// panel whose head is in sight has nothing hidden above it, and is cut from its
// foot with the scroll left alone. the browser pulls a scroll that a shortening
// layout leaves past the end of the answer, and it did so at the start of the
// cut, a step ahead of it, so the view shifted before the panel moved. so room
// is held under the answer for the run (holdSlack), enough that the view is
// never stood past its end at any frame, before anything is measured, kept from
// being let go of while the run is on (answHeld), and once it has landed only
// what the view stands on is kept (trimSlack), which is until the scroll moves
// off it. the room also covers an answer short enough to end in it, and a
// keyboard the press put away giving the view its room back while the run is on.
// a scroll that anything else moves during the run is left to it.
// a panel whose own lane was scrolled while it stood open (the sent panel's
// cut, or a small card's seat) comes down to the head of its batch over the
// same run, on a transform, rather than jumping there first.
// motion the reader has asked not to see is a plain flip, as the old fold's was,
// and the view is held for it too
const FOLD_TIMER_MS = 430;   // behind the sheet's run, for a fold with nothing to transition
function openAnswered(panel, open, change){
  const clip = panel.querySelector(".answclip");
  const mine = panel.answRun = (panel.answRun || 0) + 1;
  // where the run starts: whatever the cut and its dissolve stand at now, mid
  // run included
  const from = clip.getBoundingClientRect().height;
  const shadeFrom = answeredShade(panel);
  // cutting back: how far the batch's own lane is scrolled, read before
  // anything is laid out again
  const lane = open ? null : answeredLane(panel);
  const off = lane ? lane.scrollTop : 0;
  settleAnswered(panel);
  // the scroller the panel rides in, where the reader has it, and how much
  // answer there is with no room held under it, the panel standing as tall as
  // its sheet gives it (wide), which is more than from for a run caught opening
  const seat = panel.answView || null;
  const view = open ? null : seat;
  const at = view ? view.scrollTop : 0;
  // the part of the panel above the top of the view, in whole points so the head
  // is never scrolled into sight
  const hidden = view ?
    Math.floor(Math.max(0, view.getBoundingClientRect().top - panel.getBoundingClientRect().top)) : 0;
  const whole = view ? view.scrollHeight - heldSlack(view) : 0;
  const wide = view ? clip.getBoundingClientRect().height : 0;
  if (view) holdSlack(view, heldSlack(view) + from);   // room enough that no layout below can pull the scroll
  if (change) change();
  // a cut always shows the head of the batch, so a lane that was scrolled while
  // the panel stood open starts there; the run below carries the words down
  // to it rather than the lane jumping
  if (lane) lane.scrollTop = 0;
  panel.classList.toggle("open", open);
  // the column may have been resized while it stood open
  if (!open) fitAnswered(panel);
  const still = typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;
  const to = clip.getBoundingClientRect().height;
  // the room the answer needs under it so the view is never stood past its end,
  // at any frame, most of all at the foot of the run. the view can grow while the
  // run is on, as tall as the window under its top: a press on the phone puts the
  // keyboard away, and the view takes its room back
  const reach = view ? Math.max(view.clientHeight,
    (typeof innerHeight === "number" ? innerHeight : 0) - view.getBoundingClientRect().top) : 0;
  const room = view && at > 0 ? Math.max(0, Math.ceil(at + reach - whole + wide - to)) : 0;
  if (still || !from){
    if (view) view.scrollTop = at - Math.max(0, Math.min(hidden, from - to));
    if (seat) trimSlack(seat);
    if (panel.answRoom) panel.answRoom();
    return;
  }
  const shadeTo = panel.classList.contains("more") && !open ? "1" : "0";
  // the words the lane had scrolled up, held where the reader saw them
  const words = lane === clip ? panel.querySelector(".answstack") : lane ? panel : null;
  clip.style.height = from + "px";
  clip.style.setProperty("--answ-shade", shadeFrom);
  if (words && off) words.style.transform = "translate3d(0, " + (-off) + "px, 0)";
  void clip.offsetWidth;   // the start values land untimed
  panel.answSpan = { from, to, band: null };
  panel.classList.add("motion");
  clip.style.height = to + "px";
  clip.style.setProperty("--answ-shade", shadeTo);
  if (words && off) words.style.transform = "";   // and down to the batch's head on the run
  // the room this run needs in place of what the measuring held, with the
  // reader where they were, in the same step, before any frame is drawn
  if (view){
    holdSlack(view, room);
    view.scrollTop = at;
    view.answHeld = true;
  }
  const follow = view && hidden > 0 ? followCut(panel, view, clip, at, hidden, from) : null;
  const done = e => {
    if (e && (e.target !== clip || e.propertyName !== "height")) return;
    clip.removeEventListener("transitionend", done);
    clearTimeout(timer);
    if (mine !== panel.answRun) return;   // a newer run owns the panel now
    if (follow) follow.land(to);
    settleAnswered(panel);
    if (!open) fitAnswered(panel);
    if (seat) trimSlack(seat);
    if (panel.answRoom) panel.answRoom();
  };
  clip.addEventListener("transitionend", done);
  const timer = setTimeout(done, FOLD_TIMER_MS);
}

// the scroll going back with a cut, on every frame of its run: the frame's own
// height is read in the frame callback, which runs after the transition's value
// for that frame is set and before it is laid out and drawn, so the scroll and
// the height are written for the same frame. land writes the far end, for a run
// that ends between frames or on its timer. a scroll that is not where the last
// write left it has been moved by something else, and is not written again
function followCut(panel, view, clip, at, hidden, from){
  const mine = panel.answRun;
  const run = { seen: view.scrollTop, moved: false };
  const write = height => {
    if (run.moved) return;
    if (Math.abs(view.scrollTop - run.seen) > 1){ run.moved = true; return; }
    view.scrollTop = at - Math.max(0, Math.min(hidden, from - height));
    run.seen = view.scrollTop;
  };
  const frame = () => {
    if (panel.answRun !== mine || !panel.answSpan || run.moved) return;
    write(clip.getBoundingClientRect().height);
    if (!run.moved) requestAnimationFrame(frame);
  };
  run.land = write;
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(frame);
  return run;
}

// the run's own dress taken off: the timing and the inline ends, so the panel
// stands at the height and the dissolve the sheet gives it
function settleAnswered(panel){
  const clip = panel.querySelector(".answclip");
  const view = panel.answView;
  // room for all the clip's height that may come off, so no layout on the way
  // can pull the scroll; whoever settles lets go of what the view does not
  // stand on
  if (view && view.answHeld){
    holdSlack(view, heldSlack(view) + clip.getBoundingClientRect().height);
    view.answHeld = false;
  }
  panel.classList.remove("motion");
  panel.answSpan = null;
  clip.style.height = "";
  clip.style.removeProperty("--answ-shade");
  // and the hold a scrolled lane's words were given, if a run was cut short on it
  for (const node of [panel, panel.querySelector(".answstack")])
    if (node.style.transform) node.style.transform = "";
}

// the lane a panel's batch scrolls in while it stands open, if it has been
// scrolled: the cut itself where the page caps the opened batch (the large
// cards' sent panel), or the seat the panel stands in where the seat is capped
// instead (the small card). a panel riding in the answer's own scroller has no
// lane of its own; that scroller is its view
function answeredLane(panel){
  const clip = panel.querySelector(".answclip");
  if (clip.scrollTop > 0) return clip;
  const seat = panel.parentNode;
  if (seat && seat !== panel.answView && seat.scrollTop > 0) return seat;
  return null;
}

// the room held under the answer while a panel over it is cut back, written on
// the answer's scroller as --answ-slack, which each page stands at the foot of
// the scroller's content as a spacer. never as the scroller's own padding: the
// scroller is a flex box, and a flex box cannot stand shorter than its padding,
// so room taller than the view pushed the scroller down past its card, and the
// band the fade over the typing row is cut to, measured off the scroller's
// foot, grew with it and stayed, masking the answer out
function heldSlack(view){
  return parseFloat(view.style.getPropertyValue("--answ-slack")) || 0;
}
function holdSlack(view, held){
  if (held > 0) view.style.setProperty("--answ-slack", Math.ceil(held) + "px");
  else view.style.removeProperty("--answ-slack");
  if (!view.answSlackWatch){
    view.answSlackWatch = true;
    view.addEventListener("scroll", () => trimSlack(view), { passive: true });
  }
}
// and let go of all of it the view is not standing on. the room is at the very
// foot of the scroller, so whatever of it lies below the view goes without a
// pixel on screen moving; what the view does stand on stays until the reader
// scrolls up off it, and goes as they do. a view at its top cannot be pulled,
// so it stands on none
function trimSlack(view){
  const held = heldSlack(view);
  if (!held || view.answHeld) return;
  const need = view.scrollTop > 0 ?
    Math.max(0, Math.ceil(view.scrollTop + view.clientHeight - (view.scrollHeight - held))) : 0;
  if (need >= held) return;
  if (need) view.style.setProperty("--answ-slack", need + "px");
  else view.style.removeProperty("--answ-slack");
}

// the strength the dissolve stands at now. the strip itself says, and a run
// caught part way reports the strength it has reached; where nothing can be
// read off it, the sheet's own word for the panel as it stands is the answer
function answeredShade(panel){
  const clip = panel.querySelector(".answclip");
  const now = parseFloat(getComputedStyle(clip, "::after").opacity);
  if (!isNaN(now)) return String(now);
  return panel.classList.contains("more") && !panel.classList.contains("open") ? "1" : "0";
}

// what counts as something to read. a line or a paragraph holding nothing but
// spaces, breaks or the invisible joiners a paste brings along is blank, and so
// is the air a paragraph break leaves and the air between two messages: a
// blank line of the panel's type, which is exactly what a cut can land in.
// the joiners are named by their code points so none of them sits unseen in
// this file: zero width space, non joiner and joiner, the word joiner and the
// byte order mark
const ANSWERED_JOINERS = String.fromCharCode(0x200b, 0x200c, 0x200d, 0x2060, 0xfeff);
const ANSWERED_BLANK = new RegExp("^[\\s" + ANSWERED_JOINERS + "]*$");
const ANSWERED_TAIL = new RegExp("[\\s" + ANSWERED_JOINERS + "]+$");
// the things in a message that are seen without being text
const ANSWERED_SEEN = new Set(["IMG", "VIDEO", "AUDIO", "CANVAS", "IFRAME", "HR"]);

// a message as the panel shows it: its words with any blank tail taken off, so
// a message that ends on empty lines ends on its last line with text
function answeredText(m){
  return ((m && m.text) || "").replace(ANSWERED_TAIL, "");
}

// where the batch has ink: one box per line of text that has something on it,
// and one per picture, player or rule, each measured down from the top of the
// column of messages and stood on the whole line it sits in rather than on its
// letters alone, so the boxes meet where the lines do
function answeredInk(stack){
  const top = stack.getBoundingClientRect().top;
  const range = document.createRange();
  const boxes = [];
  const walk = node => {
    for (const child of node.childNodes){
      if (child.nodeType === 3){
        if (ANSWERED_BLANK.test(child.textContent)) continue;
        const line = parseFloat(getComputedStyle(child.parentNode).lineHeight) || 0;
        range.selectNodeContents(child);
        for (const r of range.getClientRects()){
          if (!r.height) continue;
          const spare = line > r.height ? (line - r.height) / 2 : 0;
          boxes.push({ top: r.top - top - spare, bottom: r.bottom - top + spare });
        }
      } else if (child.nodeType === 1){
        if (ANSWERED_SEEN.has(child.tagName.toUpperCase())){
          const r = child.getBoundingClientRect();
          if (r.height) boxes.push({ top: r.top - top, bottom: r.bottom - top });
        } else walk(child);
      }
    }
  };
  walk(stack);
  return boxes;
}

// whether the batch has text past the preview, and where the preview ends.
// the sheet cuts a long batch at a whole number of lines and dissolves the last
// of them, whole and from its top to its foot: two lines down, or three
// when the batch's second line is blank (a paragraph break after
// the first line, or two messages joined by their blank line), which is the
// sheet's .gap and is set here, off the ink. the panel over the answer and
// each sent bubble are cut the same way. a batch of up to two lines (three
// when its second line is blank) is no long batch at all: it is shown whole and
// stands as tall as its text. the cut is kept only while the last line before
// it has text, standing whole above it or running across it with at least half
// of itself showing (to the pixel: the cut is a rounded height and the phone's
// line is not a whole number of them): when it
// lands in blank, a paragraph break, the air between two messages or a line
// with nothing on it, the preview is stopped at the foot of the last line that
// has text instead, and it is that line the cut dissolves. a batch with no
// text past the cut is no long batch at all, however tall its blank tail: it
// gets no strip, no arrow and no fade, and it stands exactly as tall as its
// text.
// an open panel shows everything and so cannot say, and neither can one part
// way through a run: each keeps the word it was opened under. a panel that is
// not laid out measures nothing and says nothing, and the observer asks again
// once it is. answers whether the panel's height changed with it: the strip
// coming or going, or the preview stopping somewhere else
function fitAnswered(panel){
  if (panel.classList.contains("open") || panel.classList.contains("motion")) return false;
  const clip = panel.querySelector(".answclip");
  if (!clip) return false;
  const had = clip.style.getPropertyValue("--answ-stop");
  const long = panel.classList.contains("more");
  const gapped = panel.classList.contains("gap");
  clip.style.removeProperty("--answ-stop");   // read the cut the sheet gives
  let cut = clip.clientHeight;
  if (!cut){
    if (had) clip.style.setProperty("--answ-stop", had);
    return false;
  }
  const line = parseFloat(getComputedStyle(clip).lineHeight) || 0;
  const ink = answeredInk(clip.querySelector(".answstack"));
  // the second line is blank when no ink stands across the middle of it and
  // there is ink below it: a batch of one line has no second line to be blank
  const gap = line > 0 &&
    !ink.some(box => box.top < line * 1.5 && box.bottom > line * 1.5) &&
    ink.some(box => box.top >= line * 1.5);
  if (gap !== gapped){
    panel.classList.toggle("gap", gap);
    cut = clip.clientHeight;   // the cut the sheet gives it now
  }
  const end = ink.reduce((low, box) => Math.max(low, box.bottom), 0);
  // a batch holds the cut's lines whole, and a little over them: a tall glyph
  // or a small inline box is not another line, and it is more than half a line
  // past the cut that makes a long batch. a line that cannot be read leaves
  // the sheet's own cut to say
  const more = line > 0 ? end > cut + line / 2 : end > cut + 1;
  let stop = 0;
  if (more){
    // the line the cut dissolves is the last line of the preview: it stands
    // whole above the cut when it has text, so the cut is kept while some text
    // stands in the last line before it, or runs across it with at least half
    // of itself showing
    const through = ink.some(box => box.bottom > cut - line / 2 && box.top <= cut - line / 2 + 1);
    if (!through) stop = ink.reduce((low, box) => box.bottom <= cut + 1 ? Math.max(low, box.bottom) : low, 0);
  } else if (end && Math.abs(end - cut) > 1) stop = end;
  if (stop) clip.style.setProperty("--answ-stop", Math.round(stop * 100) / 100 + "px");
  panel.classList.toggle("more", more);
  return more !== long || gap !== gapped || clip.style.getPropertyValue("--answ-stop") !== had;
}

// one message is one block of the card's own prose: the same markdown, the same
// attachment markup and the same wrapping the answer is drawn in, and nothing
// around it. the blank line the sheet leaves between two blocks is the whole
// of what tells one message from the next, so a message with nothing to read in
// it adds no block, or it would stand as a second blank line.
// the blocks already standing are kept for as long as they hold the same words
// in the same place, so a pass that only adds a message, or only changes the
// badge on one, draws nothing above it again and leaves a pick of those
// words alone. a message may carry a badge in its row (sentBadge, below) and a
// state the page dresses it in: the phone says so of a message the board has not
// confirmed yet. and a sent message carries its stage (see the delivery marks
// further down): one the board has not saved yet is drawn faded, and takes its
// full ink once the board has it. a sent bubble lays its files over its words
// and shows a file picked on this page from what was kept of it (sentOrder and
// sentStills, below)
const ANSWERED_STATES = ["pending", "unsure", "failed"];

// the badge a sent row wears while its message is not through, inside the row
// and with no words on it. ring is the attachment tray's own turning ring, for
// a send the phone is still trying again on its own. fail is a red round mark
// holding a circular arrow that sends it again, with a small cross beside it
// that takes the message back. the press on either is heard in syncSent
const SENT_RING = '<svg class="tsqring" viewBox="0 0 24 24" aria-hidden="true">' +
  '<circle class="track" cx="12" cy="12" r="10.5"/><circle class="arc" cx="12" cy="12" r="10.5"/></svg>';
const SENT_RETRY = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
  ' stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>';
const SENT_CROSS = '<svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true"><path d="M1 1l6 6M7 1L1 7" ' +
  'stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
function sentBadge(kind){
  const badge = h("span", "answmark");
  badge.dataset.kind = kind;
  if (kind === "ring"){ badge.innerHTML = SENT_RING; return badge; }
  const cross = h("button", "answcross");
  cross.type = "button"; cross.dataset.act = "cross";
  cross.setAttribute("aria-label", "take the message back");
  cross.innerHTML = SENT_CROSS;
  const retry = h("button", "answretry");
  retry.type = "button"; retry.dataset.act = "retry";
  retry.setAttribute("aria-label", "send again");
  retry.innerHTML = SENT_RETRY;
  badge.append(cross, retry);
  return badge;
}

// a picture or a player in a sent bubble has nothing to draw until the board
// has sent its file back, and WebKit draws nothing at all for a player that asks
// only for the file's metadata: the bubble stood as an empty grey box over its
// arrow, and the flight's copy of it, made in the press's own task, flew with
// the picture's place blank. a file picked on this page wears what was kept of
// it (trayStill) from the bubble's first frame, the flight's copy included: a
// picture shows its own file through srcset, its address staying the board's
// for the link menu, and a video wears its square's frame as its poster, in the
// video's own shape. a player with no still here, one drawn after a reload or
// sent from the other page, is sent to the square's frame once it knows the
// file, which has WebKit fetch that frame and draw it
const SENT_STILLS = new Map();   // an uploaded file's address -> what was kept of it here
function sentStillFor(it){
  if (!it.still || !it.url) return;
  const key = CardMarkdown.safeImageTarget(it.url);
  if (!key || SENT_STILLS.has(key)) return;
  SENT_STILLS.set(key, it.still);
  // a send pressed before the square had its picture wears it now
  for (const node of document.querySelectorAll(".answered.sent video[src], .answered.sent img[src]"))
    if (node.getAttribute("src") === key) sentWear(node, it.still);
}
function sentWear(node, still){
  if (node.tagName === "IMG"){ node.setAttribute("srcset", still.url + " 1x"); return; }
  node.setAttribute("poster", still.url);
  node.style.aspectRatio = still.width + " / " + still.height;
}
// the order a sent bubble lays a message out in, whichever page sent it: its
// pictures on one line, which is what makes two to four of them the card's
// grid, then each other file on a line of its own, then the words, so a
// picture and a video both stand over the words. the phone sends its messages
// this way round already (trayMessage) and the desktop sends its words first
// (deskMessage); what was sent is left as it is, for the board and for the
// panel over the answer, and only the bubble lays it out again. a line is a
// file's when it holds nothing but uploaded files' addresses, as the tray
// writes them, and a message with a fenced block in it is left as it is
function sentOrder(text){
  const files = line => {
    const words = line.trim().split(/\s+/);
    return line.trim() && words.every(w => w.startsWith("/uploads/") && CardMarkdown.safeImageTarget(w)) ? words : null;
  };
  const lines = text.split("\n");
  if (!lines.some(files) || /^ {0,3}(```|~~~)/m.test(text)) return text;
  const pictures = [], others = [], words = [];
  for (const line of lines){
    const found = files(line);
    if (!found){ words.push(line); continue; }
    for (const url of found) (sentPicture(url) ? pictures : others).push(url);
  }
  while (words.length && ANSWERED_BLANK.test(words[0])) words.shift();
  while (words.length && ANSWERED_BLANK.test(words[words.length - 1])) words.pop();
  return [pictures.join(" "), others.join("\n"), words.join("\n")].filter(Boolean).join("\n\n");
}
// a picture by its name, as the renderer tells one (CardMarkdown.renderAttachment)
function sentPicture(url){
  const file = url.split(/[?#]/)[0].split("/").pop();
  let name = file;
  try { name = decodeURIComponent(file); } catch (e) {}
  return CardMarkdown.attachmentInfo(name)?.kind === "image";
}
function sentStills(msg){
  for (const node of msg.querySelectorAll("video[src], img[src]")){
    const still = SENT_STILLS.get(node.getAttribute("src"));
    if (still){ sentWear(node, still); continue; }
    if (node.tagName !== "VIDEO") continue;
    node.addEventListener("loadedmetadata", () => {
      if (node.readyState < 2 && !node.currentTime && !node.getAttribute("poster")) node.currentTime = TRAY_STILL_AT;
    }, { once: true });
  }
}
function stackAnswered(panel, batch){
  const stack = panel.querySelector(".answstack");
  const want = batch.filter(m => !ANSWERED_BLANK.test(answeredText(m)));
  const have = [...stack.children];
  let keep = 0;
  while (keep < have.length && keep < want.length && have[keep].dataset.text === answeredText(want[keep])) keep++;
  for (let i = have.length - 1; i >= keep; i--) have[i].remove();
  want.forEach((m, i) => {
    let msg = have[i];
    if (i >= keep){
      const text = answeredText(m);
      const sent = panel.classList.contains("sent");
      msg = h("div", "answmsg cardmd");
      msg.dataset.text = text;
      msg.innerHTML = fmt(sent ? sentOrder(text) : text);
      if (sent) sentStills(msg);
      stack.appendChild(msg);
    }
    for (const state of ANSWERED_STATES) msg.classList.toggle(state, m.state === state);
    msg.classList.toggle("undelivered", sentUndelivered(m));
    if (m.op) msg.dataset.op = m.op;
    else delete msg.dataset.op;
    const kind = m.badge || "";
    if (kind) msg.dataset.badge = kind;
    else delete msg.dataset.badge;
    let badge = [...msg.children].find(node => node.classList.contains("answmark"));
    if (badge && badge.dataset.kind !== kind){ badge.remove(); badge = null; }
    if (kind && !badge) msg.appendChild(sentBadge(kind));
  });
}

// another batch starts cut to the preview again, and is measured for it; a run
// still going on the batch it replaces is finished where it stands
function fillAnswered(panel, batch){
  stackAnswered(panel, batch);
  panel.answRun = (panel.answRun || 0) + 1;
  settleAnswered(panel);
  panel.classList.remove("open", "more", "gap");
  const clip = panel.querySelector(".answclip");
  clip.style.removeProperty("--answ-stop");
  clip.scrollTop = 0;
  fitAnswered(panel);
  if (panel.answView) trimSlack(panel.answView);
}

function dropAnswered(el, room){
  if (!el || !el.answ) return;
  el.answ.answRun = (el.answ.answRun || 0) + 1;   // a run still going lands on nothing
  if (el.answ.answWatch) el.answ.answWatch.disconnect();
  el.answ.remove();
  el.answ = null;
  el.answId = null;
  if (room) room();
}

// the one pass over the panel, for the poll, the history stepper and the small
// card alike. the reply's own name is what it is drawn from, so a pass carrying
// the same reply again touches no dom at all: an open panel stays open, nothing
// is redrawn under a selection, and nothing near the composer moves, which is
// why a draft and a caret are never disturbed by one of these passes. a
// different reply, whether it landed live or was stepped back to, takes its own
// messages into the panel already standing, so the panel does not blink out and
// back in between two pages of the history.
// room is who to tell once the panel's height has changed: the page's own
// answeredRoomChanged unless the caller names another, and the small card
// names nobody. a batch whose every message is blank has nothing to show and
// shows no panel, the way an empty batch does
function syncAnswered(el, meta, room = answeredRoomChanged){
  if (!el || !el.answwrap) return;
  const batch = answeredBatch(meta);
  if (!batch || !batch.some(m => !ANSWERED_BLANK.test(answeredText(m)))){ dropAnswered(el, room); return; }
  if (el.answ && el.answId === meta.id) return;
  if (!el.answ){
    el.answ = answeredPanel(room);
    // every message here has been answered by the reply under it, so the panel
    // carries no word of its own; it keeps the room a word would stand in, so
    // the reply sits where it did when the panel said Read (the delivery marks,
    // below)
    el.answ.classList.add("kept");
    // on a large card the panel rides at the head of the answer's own
    // scroller, whose scroll a cut back must leave where the reader has it
    el.answ.answView = el.replyview || null;
    el.answwrap.appendChild(el.answ);
  }
  el.answId = meta.id;
  fillAnswered(el.answ, batch);
  if (room) room();
}

// ---- the messages waiting for a reply -------------------------------------------------
// what has been sent on a card and not answered yet stands at the card's foot,
// over the row the reader types in, as bubbles of the very panel the answer's
// messages stand in at its head: each built by answeredPanel, filled by
// stackAnswered, cut to its preview by fitAnswered and opened and cut back by
// openAnswered, so the two cannot drift apart. what a page gives them is a seat
// of their own (el.sentwrap) and, on a large card, who to tell once they have
// taken or given back room (el.sentRoom). the board keeps a sent message on the
// card until the answer to it lands, and in that same reading it takes the
// message off here and hands it to the panel over the new answer, which is the
// page turn further down.
//
// a send the reader has just made on this page is an arrival (arrive): the new
// message comes up out of the row the words were typed in into a bubble of its
// own, under any bubble already standing, and a bubble standing open is cut back
// to its preview on the fold's own run, so what has just been sent always stands
// cut. a reading that brings messages sent somewhere else, or a first load, is
// no arrival: it moves nothing and leaves a bubble open or cut as it stands.
// which bubbles become one, and how, is further down (sentCoalesce)
const SENT_ARRIVE_MS = 400;   // the sheet's --answ-come

// The field becomes the bubble in the owner's two beats:
// the box moves sideways, then up, and compresses on its
// way from the typing box into the bubble the way a reference app's send does in
// the owner's reference recording. The copy of the
// iPhone's send that stood here before shrank the box to 77%
// and grew it back past whole, and rose past its landing and came back; the
// owner found that zoom in and out bouncy, and the stretch and close at the
// end that replaced it no better. Nothing widens past the bubble, shrinks and
// grows back, or goes past its landing.
// - Sideways: the box sets off on the first frame and its sideways move is in
//   by 260ms. The iPhone's first 50ms barely move, which it hides under its
//   frosted bar; drawn in the open here, that read as a pause as the message
//   flew out.
// - Up: the top rises, slow to start so the sideways move leads, and is on its
//   landing by 430ms and still from there until the hand-off at 650ms.
// - The compress: the box starts as the typing box itself, its width and
//   height too, and they go to the bubble's from the first frame on
//   the reference app's own length and curve (FLIGHT_MS,
//   FLIGHT_EASE_POINTS, morphBox), half way at 53ms and whole by 400ms. Across,
//   the way the box's two side edges have in common is the sideways move and
//   the rest of the longer way is the compress, so a short message's box
//   closes in from the left onto the bubble while its right end barely moves,
//   as in the recording, and neither edge ever goes back; the top keeps the
//   up curve and the foot stands where the height puts it.
// - The grey: the bubble's own grey, whole from the first frame to the last,
//   as the recording's box is drawn whole from its first moving frame, so the
//   compress is seen squeezing in for the same 14 frames or so. The iPhone's
//   faint start under its bar's glass that stood here before (13.5% over the
//   typing row, 69% above it, whole by 183ms), and the half grey of a message
//   the board has not saved yet, drew the compress's first half all but white,
//   and nothing was seen to compress. A send not saved by the landing takes
//   its faded look from the bubble it hands over to, as its words do.
// The words stay dark on grey: one copy, laid out once as the bubble lays them
// out, starts over the typed words at the typing size, rides the box's left
// edge and top, and shrinks to the bubble's size as the box goes sideways, so
// no frame is blank, doubled, or halfway through a rewrap.
// The browser draws the flight by itself: the whole of it is handed over before
// the first frame as Web Animations of transforms alone, joined straight
// between as few keyframes as keep it within SENT_TRUE_PX of its curves (about
// thirty), which the browser runs off the page's own thread. The flight the
// page drew frame by frame before stood still for two to four frames whenever
// the page was busy in the air (the board's answer, the bubbles redrawn, the
// next reading) and then jumped on, while the glide of the bubbles standing,
// already the browser's, went on smoothly: six of the seven sends in the
// owner's Mac recording. The
// page now only watches the seat, and hands the rest of the flight over again
// if the seat moves.
const SENT_FLIGHT_MS = 650;
const SENT_FRAME_MS = 1000 / 60;
const SENT_TRUE_PX = .1;
const SENT_SIDE_MS = 260;
const SENT_SIDE = [.3, .6, .4, 1];
const SENT_UP_MS = 430;
const SENT_UP = [.45, 0, .25, 1];
const SENT_COMPRESS_MS = 400;
const SENT_COMPRESS = [.22, 1, .36, 1];
// What stood before makes room on the iPhone's own glide, which is quicker
// than the bubble's rise: 58% of the way at 100ms, 99% by 333ms. One curve
// fitted to the middle of the six sends' frames, within 0.016 of each.
const SENT_GLIDE_MS = 340;
const SENT_GLIDE_EASE = "cubic-bezier(.24,.1,.15,1)";
const SENT_GLIDE = [.24, .1, .15, 1];   // the same curve, for a flight whose seat glides

const sentSideCurve = sentCurve(SENT_SIDE), sentUpCurve = sentCurve(SENT_UP);
const sentCompressCurve = sentCurve(SENT_COMPRESS), sentGlideCurve = sentCurve(SENT_GLIDE);
// the track at ms from the tap: how far the box has come across and risen and
// how far its size has gone (0 the typing box's, 1 the seat's)
function sentTrack(ms){
  return { left:sentSideCurve(ms / SENT_SIDE_MS), down:sentUpCurve(ms / SENT_UP_MS),
    size:sentCompressCurve(ms / SENT_COMPRESS_MS) };
}
// the track at every whole ms of the flight, worked out once as the page
// loads, since a flight is planned in its press's own task, before its first frame
const SENT_TRACKS = Array.from({ length:SENT_FLIGHT_MS + 1 }, (_, ms) => sentTrack(ms));
// how far in the flight's animations are held until the browser first draws
// them, so that first frame already has the box on its way. Chromium starts a
// held animation on the frame it first draws it: held a frame in, that frame
// is a frame in. WebKit starts it from the time of the frame it was made in
// and draws it a frame or two later, so unheld its first frame is already 19
// to 44ms in on the iPhone simulator (the reference recording's own first
// frame is 0.33 of the compress, about 30ms); held a frame in as well, it was
// 39 to 53ms in, a jump past the frames after it
function sentHeldMs(){
  return typeof navigator !== "undefined" && navigator.userAgentData ? SENT_FRAME_MS : 0;
}
const sentWithin = p => Math.max(0, Math.min(1, p));
// the share of their moves two opposite edges make together: none when they
// go opposite ways, else the shorter of the two
const sentShared = (a, b) => a * b <= 0 ? 0 : Math.abs(a) <= Math.abs(b) ? a : b;
// the travelling box at one point of the track, from the typing box to the
// seat as it stands: its width and height on the compress, its two side edges
// sideways by the way they share and the rest of each one's way on the
// compress, and its top on the up curve
function sentMorphBox(from, to, at){
  const mix = (a, b, p) => a + (b - a) * p;
  const way = to.left - from.left, shared = sentShared(way, to.left + to.width - from.left - from.width);
  return { left:from.left + shared * at.left + (way - shared) * at.size, top:mix(from.top, to.top, at.down),
    width:Math.max(0, mix(from.width, to.width, at.size)), height:Math.max(0, mix(from.height, to.height, at.size)) };
}

// A snapshot leaves the real editor and rendered message alone. Resolved styles
// are copied because the fixed flight lives outside the card, including outside
// the desktop's scaled stage. Text alone scales, by that stage's existing factor
// and in flight from the typing size to the bubble's and by the track's size;
// the box itself keeps real viewport geometry, cut out by clips that only
// move, never transform scale.
const SENT_SNAPSHOT_STYLE = [
  "box-sizing", "display", "position", "top", "right", "bottom", "left", "font", "font-family", "font-size", "font-weight",
  "font-style", "line-height", "letter-spacing", "color", "text-align", "text-indent",
  "text-decoration", "white-space", "overflow-wrap", "word-break", "tab-size",
  "padding", "margin", "border", "border-radius", "background", "box-shadow",
  "width", "height", "min-width", "max-width", "min-height", "max-height",
  "overflow", "opacity", "vertical-align", "list-style", "gap", "align-items",
  "justify-content", "flex-direction", "flex", "object-fit", "object-position",
  "--answ-fill", "--answ-fade", "--answ-shade", "--answ-stop", "--answ-peek",
  "--answ-round", "--answ-strip", "--answ-line", "--u"
];
// badges: a bubble pictured for its merge keeps the badges in its rows, which
// stay on screen the whole way; the flight's copy has none
function sentSnapshot(node, badges){
  const plain = node.tagName === "TEXTAREA";
  const copy = plain ? document.createElement("div") : node.cloneNode(true);
  if (plain) copy.textContent = node.value;
  const originals = [node, ...(plain ? [] : node.querySelectorAll("*"))];
  const copies = [copy, ...copy.querySelectorAll("*")];
  originals.forEach((source, i) => {
    const dest = copies[i], style = getComputedStyle(source);
    for (const name of SENT_SNAPSHOT_STYLE) dest.style.setProperty(name, style.getPropertyValue(name));
    dest.removeAttribute("id");
    dest.removeAttribute("contenteditable");
    dest.removeAttribute("data-mark");
    dest.classList.remove("arrive", "motion", "sentflight", "markin", "markout", "markmove", "markgone", "coalesce");
    dest.style.setProperty("animation", "none", "important");
    dest.style.setProperty("transition", "none", "important");
    dest.style.setProperty("caret-color", "transparent");
  });
  for (const decor of copy.querySelectorAll(badges ? ".cm-cursorLayer, .cm-selectionLayer" :
    ".cm-cursorLayer, .cm-selectionLayer, .answmark")) decor.remove();
  Object.assign(copy.style, { position:"relative", left:"0", top:"0", margin:"0",
    minWidth:"0", maxWidth:"none", minHeight:"0", transform:"none", pointerEvents:"none" });
  copy.sentInk = originals.map((source, i) => ({ source, copy:copies[i] }))
    .filter(pair => pair.source.parentElement && pair.source.parentElement.classList.contains("answmsg"));
  if (plain) copy.style.whiteSpace = "pre-wrap";
  return copy;
}
function sentScale(node, rect){
  return { x:node.offsetWidth ? rect.width / node.offsetWidth : 1,
    y:node.offsetHeight ? rect.height / node.offsetHeight : 1 };
}
function sentMotionVisible(node){
  if (!node || !node.isConnected) return false;
  const rect = node.getBoundingClientRect();
  if (!(rect.width > 0 && rect.height > 0)) return false;
  for (let at = node; at && at !== document.body; at = at.parentElement){
    const style = getComputedStyle(at);
    if (style.visibility === "hidden" || style.display === "none") return false;
  }
  return true;
}
// a node of the seat on screen, a bubble hidden for its merge's fall included,
// whose layer is what is seen of it, and the seat's ground over it
function sentSeen(el, node){
  const run = el && el.sentMerge;
  if (run && run.stage === "merge" && (node === run.a || node === run.floor))
    return !!node.isConnected && sentMotionVisible(el.sentwrap);
  return sentMotionVisible(node);
}
// Where a card shows its foot, in viewport px: the boxes above the seat that
// cut what overflows them, met, up to the first box fixed to the viewport,
// which nothing above it can cut. The body's own overflow is the window's, so
// the walk stops under it. Null when nothing above the seat cuts, as on the
// small card, whose foot is seen wherever it stands. The flight is cut here
// too: it stands outside the card, and the typing row a long message grows
// can reach past what the card shows of it (a card laid out shorter than the
// row's cap), as can the bubble it lands on, and the flight drew those parts
// over the card's head and past its edge.
function sentView(seat){
  const cuts = value => !!value && value !== "visible";
  let view = null;
  for (let at = seat && seat.parentElement; at && at !== document.body; at = at.parentElement){
    const style = getComputedStyle(at);
    const x = cuts(style.overflowX), y = cuts(style.overflowY);
    if (x || y){
      const rect = at.getBoundingClientRect(), scale = sentScale(at, rect);
      const left = rect.left + (at.clientLeft || 0) * scale.x, top = rect.top + (at.clientTop || 0) * scale.y;
      const page = document.documentElement;
      view = view || { left:0, top:0, right:page.clientWidth, bottom:page.clientHeight };
      if (x){ view.left = Math.max(view.left, left); view.right = Math.min(view.right, left + at.clientWidth * scale.x); }
      if (y){ view.top = Math.max(view.top, top); view.bottom = Math.min(view.bottom, top + at.clientHeight * scale.y); }
    }
    if (style.position === "fixed") break;
  }
  return view && { left:view.left, top:view.top,
    width:Math.max(0, view.right - view.left), height:Math.max(0, view.bottom - view.top) };
}

// Arm before the page empties its composer; play in that same task after the
// message has its seat. Every send flies into a bubble of its own, the way the
// first one always has, under the bubbles already standing; they make room on
// the iPhone's glide, and the bubbles come together later, once the rule says
// they may (sentCoalesce, below).
function armSentMotion(el){
  if (!el || !el.ta || stillMotion() || typeof requestAnimationFrame !== "function") return null;
  const field = typeof ComposeFormat !== "undefined" && ComposeFormat.fieldOf(el.ta);
  const source = field && field.formatted() && field.view ? field.view.scrollDOM : el.ta;
  if (!sentMotionVisible(source) || typeof source.animate !== "function") return null;
  const standing = sentPanels(el);
  // The bubbles already standing are pushed up by the new one in their seat,
  // and a bubble part way through its fall with the seat's ground over it.
  // The answer is not among them: it stands still whatever the bubbles do
  // (sentKeepScroll, and the desktop's snap, which leaves the seat out)
  const fallFloor = el.sentMerge && el.sentMerge.stage === "merge" && el.sentMerge.floor;
  const beforeNeighbors = (fallFloor ? [...standing, fallFloor] : standing).filter(node => sentSeen(el, node))
    .map(node => ({ node, rect:node.getBoundingClientRect() }));
  // Read the previous shifts before replacing them. Existing shells keep
  // flying toward their live seats, so a quick second send never teleports
  // the first bubble out of its unfinished flight.
  const flights = el.sentMotions || (el.sentMotions = new Set());
  for (const flight of flights) flight.stopShifts();
  const rows = new Set(standing.flatMap(sentRows));
  const start = source.getBoundingClientRect(), sourceScale = sentScale(source, start);
  const sourceStyle = getComputedStyle(source);
  const corners = ["borderTopLeftRadius", "borderTopRightRadius", "borderBottomRightRadius", "borderBottomLeftRadius"];
  const startCorners = corners.map(name => (parseFloat(sourceStyle[name]) || 0) * sourceScale.x);
  // where the typed words start and how big they are, in viewport px
  const typedSize = (parseFloat(sourceStyle.fontSize) || 17) * sourceScale.y;
  const typed = {
    left:start.left + (parseFloat(sourceStyle.paddingLeft) || 0) * sourceScale.x,
    top:start.top + ((parseFloat(sourceStyle.paddingTop) || 0) - source.scrollTop) * sourceScale.y,
    size:typedSize,
    line:(parseFloat(sourceStyle.lineHeight) * sourceScale.y) || typedSize * 1.5,
  };
  // The box is cut out of a grey face by four clips nested one in the next, each
  // as large as the box ever is and rounding one corner of it: each clip rides
  // its own corner, so the four cut out the box at its width and height while
  // each only moves. Inside them the ground the face and the words stand on is
  // held at the viewport's origin, so everything in it is placed in viewport px.
  // The shell itself is cut where the card shows its foot (sentView), and the
  // four stand in a frame held at the viewport's origin inside that cut, so the
  // flight shows only what the card would show of the row and of the bubble
  const shell = document.createElement("div");
  shell.className = "sentmorph";
  shell.setAttribute("aria-hidden", "true");
  const view = document.createElement("div");
  view.className = "sentmorph-view";
  const clips = corners.map(() => {
    const clip = document.createElement("div");
    clip.className = "sentmorph-clip";
    return clip;
  });
  const ground = document.createElement("div");
  ground.className = "sentmorph-ground";
  clips.reduce((outer, inner) => outer.appendChild(inner)).appendChild(ground);
  view.appendChild(clips[0]);
  shell.appendChild(view);
  // the cut, written again whenever the flight is handed over again, since
  // whatever moved the seat may have moved the card's foot with it
  const cut = () => {
    const seen = sentView(el.sentwrap);
    if (!seen) return;
    Object.assign(shell.style, { left:seen.left + "px", top:seen.top + "px",
      width:seen.width + "px", height:seen.height + "px", overflow:"hidden" });
    Object.assign(view.style, { left:-seen.left + "px", top:-seen.top + "px" });
  };
  const face = document.createElement("div");
  face.className = "sentmorph-face";
  face.style.background = getComputedStyle(el.box || source).getPropertyValue("--card").trim() || "#fff";
  const outgoing = document.createElement("div");
  outgoing.className = "sentmorph-source";
  const sourceCopy = sentSnapshot(source);
  sourceCopy.style.opacity = "1"; // the phone may be blinking its caret layer off at the press
  sourceCopy.style.width = (start.width / sourceScale.x) + "px";
  sourceCopy.style.height = (start.height / sourceScale.y) + "px";
  outgoing.style.transform = "translate(" + start.left + "px," + start.top + "px) scale(" + sourceScale.x + "," + sourceScale.y + ")";
  outgoing.appendChild(sourceCopy);
  const incoming = document.createElement("div");
  incoming.className = "sentmorph-target";
  ground.append(face, outgoing, incoming);
  // the clips' own size, and where each layer stands for a box: the first clip
  // at the box's top left, the next three by how far their corners stand from
  // the one before (the top right, the foot's right, the foot's left), and the
  // ground back at the origin
  const room = { width:0, height:0 };
  const fit = (width, height) => {
    Object.assign(room, { width, height });
    for (const clip of clips) Object.assign(clip.style, { width:width + "px", height:height + "px" });
  };
  const layers = box => [[box.left, box.top], [box.width - room.width, 0], [0, box.height - room.height],
    [room.width - box.width, 0], [-box.left, room.height - box.height - box.top]];
  const move = ([x, y]) => "translate(" + x + "px," + y + "px)";
  const place = box => layers(box).forEach((at, i) => { (clips[i] || ground).style.transform = move(at); });
  const round = radii => clips.forEach((clip, i) => { clip.style[corners[i]] = radii[i] + "px"; });
  const cover = boxes => {
    const left = Math.min(...boxes.map(b => b.left)), top = Math.min(...boxes.map(b => b.top));
    Object.assign(face.style, { left:left + "px", top:top + "px",
      width:Math.max(...boxes.map(b => b.left + b.width)) - left + "px", height:Math.max(...boxes.map(b => b.top + b.height)) - top + "px" });
  };
  fit(start.width, start.height);
  place(start);
  round(startCorners);
  cover([start]);
  cut();
  document.body.appendChild(shell);
  sourceCopy.scrollTop = source.scrollTop;
  sourceCopy.scrollLeft = source.scrollLeft;
  let raf = 0, done = false, played = false, target = null, panel = null, flying = [];
  const shifts = [];
  const stopShifts = () => {
    for (const shift of shifts.splice(0)) shift.cancel();
  };
  let previousOpacity = "", previousPriority = "";
  const finish = () => {
    if (done) return;
    done = true;
    if (raf) cancelAnimationFrame(raf);
    stopShifts();
    for (const anim of flying.splice(0)) anim.cancel();
    if (target){
      if (previousOpacity) target.style.setProperty("opacity", previousOpacity, previousPriority);
      else target.style.removeProperty("opacity");
    }
    shell.remove();
    flights.delete(motion);
    const landedPanel = panel || el.sent;
    const stillFlying = [...flights].some(flight => flight.panel === landedPanel);
    if (landedPanel && !stillFlying){
      landedPanel.classList.remove("sentflight");
      // An ACK can land during the flight. Its reserved seat never moves, and
      // the word takes its own gentle entrance once the bubble is visible,
      // unless the bubble is waiting to join the one above it, whose word
      // moves down to it first (sentMove).
      setMark(landedPanel, landedPanel.dataset.tag || "", true);
    }
    if (el.sentMotion === motion) el.sentMotion = [...flights].at(-1) || null;
    if (!stillFlying && el.sentRoom && el.sent && el.sent.isConnected) el.sentRoom();
    sentCoalesce(el);
  };
  const motion = {
    cancel:finish, stopShifts, panel:null,
    play(){
      if (done || played) return;
      played = true;
      // the bubble the new words stand in, which was not standing before
      const bubbles = sentPanels(el);
      const fresh = bubbles.flatMap(sentRows).filter(row => !rows.has(row));
      const row = fresh[fresh.length - 1] || null;
      panel = motion.panel = row ? bubbles.find(one => sentRows(one).includes(row)) || null : null;
      if (!panel || standing.includes(panel) || !sentMotionVisible(panel) || stillMotion()){ finish(); return; }
      target = panel;
      panel.classList.add("sentflight");
      // What stood before glides from where it stood: every bubble the new one
      // pushes up.
      for (const { node, rect } of beforeNeighbors){
        if (!sentSeen(el, node) || typeof node.animate !== "function") continue;
        const after = node.getBoundingClientRect(), scale = sentScale(node, after);
        const dx = (rect.left - after.left) / scale.x, dy = (rect.top - after.top) / scale.y;
        if (Math.abs(dx) <= .5 && Math.abs(dy) <= .5) continue;
        const transform = getComputedStyle(node).transform || "none";
        const shift = node.animate(
          [{ transform:"translate(" + dx + "px," + dy + "px) " + (transform === "none" ? "" : transform) }, { transform }],
          { duration:SENT_GLIDE_MS, easing:SENT_GLIDE_EASE });
        shifts.push(shift);
        // an earlier send still in the air takes this glide into its seat
        // whole, from the glide's first frame (follow, below)
        node.sentGlide = { shift, x:rect.left - after.left, y:rect.top - after.top };
      }
      const targetRect = target.getBoundingClientRect(), targetScale = sentScale(target, targetRect);
      const targetCopy = sentSnapshot(target);
      targetCopy.style.width = (targetRect.width / targetScale.x) + "px";
      targetCopy.style.height = (targetRect.height / targetScale.y) + "px";
      targetCopy.style.background = "transparent";
      incoming.appendChild(targetCopy);
      // One copy of the words from here on, at full strength the whole way: the
      // typed copy goes in the same task, and the strength a message not yet
      // saved is drawn at is the landed bubble's own, not the flight's, for the
      // words and the grey alike.
      outgoing.remove();
      targetCopy.style.opacity = "1";
      for (const pair of targetCopy.sentInk) pair.copy.style.opacity = "1";
      incoming.style.opacity = "1";
      // the row holding the new words, where its first line starts inside the
      // copy, and the size and line it is set in, in viewport px
      const ink = row;
      const inkRect = ink.getBoundingClientRect(), inkStyle = getComputedStyle(ink);
      const lead = {
        x:inkRect.left - targetRect.left + (parseFloat(inkStyle.paddingLeft) || 0) * targetScale.x,
        y:inkRect.top - targetRect.top + (parseFloat(inkStyle.paddingTop) || 0) * targetScale.y,
      };
      const inkSize = (parseFloat(inkStyle.fontSize) || 0) * targetScale.y;
      const grow = inkSize > 0 ? typed.size / inkSize : 1;
      const inkLine = (parseFloat(inkStyle.lineHeight) * targetScale.y) || inkSize * 1.4;
      // the words start on the typed words: the first line's left on theirs and
      // its middle on the typed line's middle, at the typing size, held as where
      // they stand inside the start box
      const from = { x:typed.left - start.left, y:typed.top + typed.line / 2 - start.top };
      const panelStyle = getComputedStyle(panel);
      const endCorners = corners.map(name => (parseFloat(panelStyle[name]) || 0) * targetScale.x);
      // the bubble's face and corners, written before the first frame and kept
      // for the whole flight: the grey a saved message stands on, whole, and
      // the dissolve at a long message's cut in that same grey
      round(endCorners);
      const grey = panelStyle.getPropertyValue("--bubble-fill").trim() || panelStyle.backgroundColor;
      face.style.background = grey;
      face.style.opacity = "1";
      const copiedCut = targetCopy.querySelector(".answclip");
      if (copiedCut) copiedCut.style.setProperty("--answ-fill", grey);
      // one moment of the flight, ms from the tap, on a seat: the travelling
      // box, and the words riding its left edge and top: their first line's
      // left goes from the typed words' place in it to the bubble's as the box
      // goes sideways, its middle as it rises, and they shrink from the typing
      // size to the bubble's as the box goes sideways
      const at = (ms, seat) => {
        const track = SENT_TRACKS[ms] || sentTrack(ms), box = sentMorphBox(start, seat, track);
        const across = sentWithin(track.left), rise = sentWithin(track.down);
        const k = grow + (1 - grow) * across;
        const to = { x:lead.x, y:lead.y + inkLine / 2 };
        const lineLeft = box.left + from.x + (to.x - from.x) * across;
        const lineMiddle = box.top + from.y + (to.y - from.y) * rise;
        return { box, x:lineLeft - lead.x * k, y:lineMiddle - (lead.y + inkLine / 2) * k, k };
      };
      const words = one => "translate(" + one.x + "px," + one.y + "px) scale(" + targetScale.x * one.k + "," + targetScale.y * one.k + ")";
      // how far the copy reaches from its corner, so a change in its scale is
      // weighed in px
      const reach = Math.max(targetRect.width, targetRect.height);
      // a box's edges on whole device pixels, where the bubble's own grey is
      // painted: the clips cut where they are put, so a box landing between
      // pixels stood up to a pixel inside the bubble each side, and stepped out
      // to it at the hand-over (0.3 to 0.6pt on the iPhone simulator)
      const dpr = typeof devicePixelRatio === "number" && devicePixelRatio > 0 ? devicePixelRatio : 0;
      const onPixels = r => {
        if (!dpr) return r;
        const px = v => Math.round(v * dpr) / dpr, left = px(r.left), top = px(r.top);
        return { left, top, width:px(r.left + r.width) - left, height:px(r.top + r.height) - top };
      };
      // the seat at ms of the flight: the new bubble as laid out, and moved by
      // the glide a later send gives it, whose offset goes to nothing on the
      // glide's own curve from the flight's ms it set off at; as the page reads
      // it, or as the flight lands on it, on whole pixels
      const seat = { base:targetRect, glide:null, since:0, seen:target.sentGlide || null };
      const held = sentHeldMs();
      const seatAt = (ms, drawn) => {
        const { glide, since } = seat, base = drawn ? onPixels(seat.base) : seat.base;
        const left = glide ? 1 - sentGlideCurve((ms - since) / SENT_GLIDE_MS) : 0;
        return left ? { left:base.left + glide.x * left, top:base.top + glide.y * left, width:base.width, height:base.height } : base;
      };
      // the whole flight handed to the browser on that seat: each layer's
      // transform at as few moments as keep every edge, the words' place and
      // their reach within SENT_TRUE_PX of where the curves put them on every
      // ms, joined straight. a flight handed over again goes on from the same
      // start, so the clock carries on through the change
      const hand = () => {
        const all = [];
        for (let ms = 0; ms <= SENT_FLIGHT_MS; ms++) all.push(at(ms, seatAt(ms, true)));
        const marks = all.map(({ box, x, y, k }) => [box.left, box.top, box.left + box.width, box.top + box.height, x, y, k * reach]);
        const straight = (i, j) => {
          for (let n = i + 1; n < j; n++) for (let v = 0; v < marks[n].length; v++)
            if (Math.abs(marks[i][v] + (marks[j][v] - marks[i][v]) * (n - i) / (j - i) - marks[n][v]) > SENT_TRUE_PX) return false;
          return true;
        };
        // each curve's landing is a keyframe of its own, so nothing creeps on
        // once its move is in
        const lands = [SENT_SIDE_MS, SENT_COMPRESS_MS, SENT_UP_MS, SENT_FLIGHT_MS];
        const moments = [0];
        for (let i = 0; i < SENT_FLIGHT_MS;){
          const stop = lands.find(ms => ms > i);
          let j = i + 1;
          while (j < stop && straight(i, j + 1)) j++;
          moments.push(j);
          i = j;
        }
        const frames = moments.map(ms => all[ms]), boxes = frames.map(one => one.box);
        fit(Math.max(...all.map(one => one.box.width)) + 1, Math.max(...all.map(one => one.box.height)) + 1);
        cover(all.map(one => one.box));
        cut();
        const keys = transform => moments.map((ms, i) => ({ offset:ms / SENT_FLIGHT_MS, transform:transform(i) }));
        const timing = { duration:SENT_FLIGHT_MS, fill:"both", easing:"linear" };
        const before = flying;
        flying = [...clips, ground].map((node, n) => node.animate(keys(i => move(layers(boxes[i])[n])), timing));
        flying.push(incoming.animate(keys(i => words(frames[i])), timing));
        const clock = before[0];
        for (const anim of flying){
          if (clock && typeof clock.startTime === "number") anim.startTime = clock.startTime;
          else anim.currentTime = clock && typeof clock.currentTime === "number" ? clock.currentTime : held;
        }
        for (const anim of before) anim.cancel();
      };
      // the seat as it stands at a frame: a later send's glide is taken whole,
      // from its first frame; any other move is met from the frame it is seen
      // on, as the frame-by-frame flight met it, and nothing is handed over again
      // while the seat stands where the flight is going
      const follow = ms => {
        const now = target.getBoundingClientRect(), glide = target.sentGlide || null;
        const fresh = glide !== seat.seen;
        if (fresh){
          seat.seen = glide;
          seat.glide = glide && glide.shift.playState !== "idle" ? glide : null;
          seat.since = ms - (seat.glide && typeof glide.shift.currentTime === "number" ? glide.shift.currentTime : 0);
        }
        const want = seatAt(ms);
        if (!fresh && ["left", "top", "width", "height"].every(key => Math.abs(now[key] - want[key]) <= .5)) return;
        if (seat.glide && seat.glide.shift.playState === "idle") seat.glide = null;
        const off = seatAt(ms);
        seat.base = { left:now.left - (off.left - seat.base.left), top:now.top - (off.top - seat.base.top), width:now.width, height:now.height };
        hand();
      };
      previousOpacity = target.style.getPropertyValue("opacity");
      previousPriority = target.style.getPropertyPriority("opacity");
      target.style.setProperty("opacity", "0");
      // the first frame the browser draws already has the box on its way,
      // however late it comes (sentHeldMs): until the press the typed words
      // stood where the box starts; started on the press itself, the first
      // frame drew the box standing still on the row, and a first frame late
      // after the send's own work kept it there longer
      hand();
      // under them, the start box and the words over the typed ones
      const first = at(0, seatAt(0, true));
      place(first.box);
      incoming.style.transform = words(first);
      // the page's own frames only watch: whether the flight should stop, and
      // where the seat stands. they write nothing while the seat stays put, so
      // a frame the page is too busy to run holds nothing still. their clock
      // starts as the animations' does, at the first frame less what they are
      // held at
      let t0 = null;
      const step = now => {
        raf = 0;
        if (done) return;
        if (!target.isConnected || !sentMotionVisible(panel) || stillMotion()){ finish(); return; }
        if (t0 === null) t0 = now - held;
        const ms = Math.max(0, Math.min(SENT_FLIGHT_MS, now - t0));
        follow(ms);
        if (ms < SENT_FLIGHT_MS) raf = requestAnimationFrame(step);
        else raf = requestAnimationFrame(finish);
      };
      raf = requestAnimationFrame(step);
    }
  };
  flights.add(motion);
  el.sentMotion = motion;
  return motion;
}
function sentBatch(texts){ return (texts || []).map(text => ({ text })); }

// ---- the delivery marks ------------------------------------------------------------------
// a sent message is in one of three states, and a page holds it under one of
// four stage names: the first is the page's own, the rest the board's, from its
// record of the message (pendingStates and notedTexts on a reading, server.py's
// _pending_states):
//   local      the board has not saved it yet, so it would be lost if the page
//              were closed: a send still on its way (the phone's own, or the
//              desktop's between the press and the board's answer). drawn
//              faded, the panel's grey and the words both, while every message
//              in the panel is still local, and the words alone when an older
//              message in it is saved. no word stands for it, the fade says it.
//              a send that is not getting through keeps this stage and wears
//              the badge of its row (sentBadge) as well: a failure, not a state
//   sent       the board has saved it: Delivered, at full ink
//   delivered  an agent has picked it up, its listener confirmed the claim
//              carrying it: Read
//   read       the agent has written back since it picked it up: a progress
//              note over its claim, a note that took it toward the answer still
//              to come, or the answer itself. it looks as delivered does, Read
// the panel carries one quiet mark under its foot, the way a chat marks the
// newest message that has got anywhere: Delivered or Read for the newest
// message in it that the board has saved, and nothing while none is. once the
// reply to those messages lands the word is dropped: it fades out as the page
// turns (fadeMark) and the panel over the reply carries none, so a card drawn
// with its reply already there shows no word at all. a message with no stage
// (a board too old to say) is drawn as it always was and marks nothing
const SENT_TAGS = { sent: "Delivered", delivered: "Read", read: "Read" };
function sentUndelivered(m){ return m.stage === "local"; }
// a send on its way to the board, drawn faded from the press: el is the card's
// page object, which holds its sentItems and its guard. the board's readings
// are kept from replacing the list for as long as any send is out, since one
// asked before the board had the words knows nothing of them. every send is an
// operation, its id minted here before the first try and kept for every try
// after it; route is the path it is posted to, without the id
function sentLaunch(el, text, route){
  const item = { text, stage: "local", op: newOpId(), ts: Date.now(), route };
  el.sentItems = [...el.sentItems, item];
  el.sendsOut = (el.sendsOut || 0) + 1;
  el.sendGuard = Infinity;
  syncSent(el, el.sentItems, true);
  draftSave(draftCardOf(el));   // kept until the board has it (draftUnsent)
  return item;
}
function sentSettled(el){
  el.sendsOut = Math.max(0, (el.sendsOut || 0) - 1);
  if (!el.sendsOut) el.sendGuard = Date.now();
}
// the board answered: the message is saved, and stands as sent until a reading
// says more. a reading asked before this moment may not take it away
function sentLanded(el, item){
  if (item.stage !== "local") return;
  item.stage = "sent";
  sentSettled(el);
  syncSent(el, el.sentItems);
  draftSave(draftCardOf(el));
}
// one try of a send, under the id it was minted with. the board keeps a receipt
// beside the message, so a try asked again after a lost answer is answered from
// the receipt and the words never land twice. landed is the board's yes and
// refused its no, which sending again cannot change. failed is anything else,
// no answer within OP_TRY_MS included, and says nothing about whether the words
// landed
const SENT_REFUSED = new Set([400, 409, 413]);
async function sentTry(item){
  let r;
  try {
    r = await fetch(item.route + "&op=" + encodeURIComponent(item.op),
      { method: "POST", body: item.text, signal: AbortSignal.timeout(OP_TRY_MS) });
  } catch (e) { return "failed"; }
  return r.ok ? "landed" : SENT_REFUSED.has(r.status) ? "refused" : "failed";
}
// the try did not get through. the message stays in the panel, faded as it was,
// with the fail badge, and is held out of the board's readings, which would
// otherwise take it away. refused is the board's own no
function sentFailed(el, item, refused){
  if (item.stage !== "local") return;
  item.badge = "fail"; item.refused = !!refused; item.checked = false;
  el.sentItems = el.sentItems.filter(m => m !== item);
  el.sentHeld = [...(el.sentHeld || []), item];
  sentSettled(el);
  syncSent(el, el.sentItems);
}
function sentHeldOut(el, item){
  el.sentHeld = (el.sentHeld || []).filter(m => m !== item);
}
// the arrow: the held message goes out again under its own id, drawn as any
// send on its way is. a refused message is not sent again
async function sentRetry(el, item){
  if (item.refused || !(el.sentHeld || []).includes(item)) return;
  sentHeldOut(el, item);
  item.badge = "";
  el.sentItems = [...el.sentItems, item];
  el.sendsOut = (el.sendsOut || 0) + 1;
  el.sendGuard = Infinity;
  syncSent(el, el.sentItems);
  const result = await sentTry(item);
  if (result === "landed"){
    sentLanded(el, item);
    if (item.landed) item.landed();
  } else sentFailed(el, item, result === "refused");
}
// the board has the held message after all: it stands as sent, Delivered, and
// nothing is taken back
function sentHeldLanded(el, item){
  sentHeldOut(el, item);
  item.badge = ""; item.stage = "sent";
  el.sentItems = [...el.sentItems, item];
  if (!el.sendsOut) el.sendGuard = Date.now();
  syncSent(el, el.sentItems);
  draftSave(draftCardOf(el));
  if (item.landed) item.landed();
}
// the words go back in the typing row, after what is already there and never
// over it, and the message leaves the panel
function sentBack(el, item){
  sentHeldOut(el, item);
  const draft = el.ta.value;
  el.ta.value = draft.trim() ? draft.trimEnd() + "\n\n" + item.text : item.text;
  el.tick();
  draftSave(draftCardOf(el));
  syncSent(el, el.sentItems);
}
// what a lookup of the board's receipt for an operation answers, or null when
// the board could not be reached, which is no answer at all
async function askReceipt(id){
  try {
    const r = await fetch("/op?id=" + encodeURIComponent(id), { signal: AbortSignal.timeout(OP_TRY_MS) });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}
// the cross. a refused message is known not to have landed, so its words come
// back at once. any other failure leaves it unknown, so the board is asked
// first: landed, and the row becomes Delivered with nothing taken back; not
// landed, and the words go back; no answer, and nothing happens
async function sentCross(el, item){
  if (!(el.sentHeld || []).includes(item) || item.asking) return;
  if (item.refused){ sentBack(el, item); return; }
  item.asking = true;
  let said;
  try { said = await askReceipt(item.op); } finally { item.asking = false; }
  if (!said || !(el.sentHeld || []).includes(item)) return;
  if (said.status === "applied") sentHeldLanded(el, item);
  else if (said.status === "unknown" && Date.now() - item.ts < OP_CERTAIN_MS) sentBack(el, item);
}
// a reading the board has just answered asks it once about each held message
// it has not been asked about, so a send whose answer was lost on the way and
// that landed is shown Delivered rather than as failed
async function sentAskHeld(el){
  for (const item of [...(el.sentHeld || [])]){
    if (item.refused || item.checked || item.asking) continue;
    item.asking = true;
    let said;
    try { said = await askReceipt(item.op); } finally { item.asking = false; }
    if (!said) continue;
    item.checked = true;
    if (said.status === "applied" && (el.sentHeld || []).includes(item)) sentHeldLanded(el, item);
  }
}
// how long after the press the board's answer "unknown" still proves the words
// never landed. a receipt is kept at least two days from the moment the board
// committed it, which is never before the press, so inside this window no
// receipt means no commit. past it, unknown proves nothing
const OP_CERTAIN_MS = 36 * 3600 * 1000;
// how long one try waits for the board's answer
const OP_TRY_MS = 10000;
function newOpId(){
  if (crypto.randomUUID) return crypto.randomUUID();
  return [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, "0")).join("");
}
// the panel's list, out of the board's reading of a card: what a note has
// already taken toward the answer to come, which is read, then the queued
// messages, each where it stands
function sentFrom(b){
  const noted = ((b && b.notedTexts) || []).map(text => ({ text, stage: "read" }));
  const texts = (b && b.pendingTexts) || [], states = (b && b.pendingStates) || [];
  return noted.concat(texts.map((text, i) => ({ text, stage: states[i] || "" })));
}
// the mark's own motion, which the sheet draws (card-tokens.css): a word comes
// in over the send's run (--answ-come), and one giving way to another goes out
// over half of it first. data-tag is where the board's record has the panel,
// data-mark the word on show, and they part only for the length of a change.
// a panel drawn with its mark, or a reader who asked for no motion, is given the
// word at once; the change of a panel already standing is the one that moves.
// a change that lands while another is going is not started again: the swap
// under way reads the record when it lands. clocks end it, since a page that
// runs no transitions never says so
const MARK_OUT_MS = 200;   // half the sheet's --answ-come
const MARK_IN_MS = 400;    // the sheet's --answ-come
// a sent bubble waiting to join the one above it is held (markHeld): its record
// is kept, and its word is the merge's to move (sentMove)
function setMark(panel, tag, live){
  if (tag) panel.dataset.tag = tag;
  else delete panel.dataset.tag;
  if (panel.classList.contains("sentflight")) return;
  if (panel.markHeld) return;
  if (panel.classList.contains("markout")) return;
  const shown = panel.dataset.mark || "";
  if (tag === shown) return;
  if (!live || stillMotion()){ showMark(panel, tag, false); return; }
  if (!shown){ showMark(panel, tag, true); return; }
  panel.classList.add("markout");
  setTimeout(() => {
    panel.classList.remove("markout");
    showMark(panel, panel.markHeld ? "" : panel.dataset.tag || "", true);
    if (panel.sentAgain) panel.sentAgain();
  }, MARK_OUT_MS);
}
function showMark(panel, tag, comes){
  const roomMoves = !panel.classList.contains("sent") && (!panel.dataset.mark !== !tag);
  const run = panel.markRun = (panel.markRun || 0) + 1;
  panel.classList.remove("markin");
  if (tag) panel.dataset.mark = tag;
  else delete panel.dataset.mark;
  if (!comes) return;
  if (tag) panel.classList.add("markin");
  // Sent panels already reserve this space. Only a mark on another panel can
  // change its room; tell that panel's card once the run has stopped.
  setTimeout(() => {
    if (panel.markRun === run) panel.classList.remove("markin");
    if (roomMoves && panel.isConnected && panel.answRoom) panel.answRoom();
  }, MARK_IN_MS + 20);
}
// the reply to the panel's messages has landed, and the word under it fades out
// over the sheet's --answ-gone and stays gone. the room it stood in is kept
// (the sheet's .kept), so nothing below the panel moves. it is the picture of
// the panel that the page turn carries up which is faded, since the panel
// itself is already gone from the page, and the picture is gone before the
// word could come back
function fadeMark(panel){
  panel.classList.add("kept");
  delete panel.dataset.tag;
  if (panel.dataset.mark) panel.classList.add("markgone");
}
// the word a bubble carries: Delivered or Read for the newest message in it
// that the board has saved, and nothing while none is
function sentTagOf(shown){
  const got = [...shown].reverse().find(m => SENT_TAGS[m.stage]);
  return got ? SENT_TAGS[got.stage] : "";
}
// the panel's one mark, and whether every message in it is still unsaved by the
// board. live is a panel that was standing before this reading
function sentMarks(panel, shown, live){
  const tag = sentTagOf(shown);
  setMark(panel, tag, live);
  panel.classList.toggle("undelivered", shown.every(sentUndelivered));
  panel.setAttribute("aria-label", "your messages waiting for a reply" + (tag ? ", " + tag.toLowerCase() : ""));
}

// the press on a badge's arrow or cross. the page says what each does to the
// message it belongs to (sentMarkAct), the panel's own press is not given it
function sentBadgePress(el, e){
  const button = e.target && e.target.closest && e.target.closest(".answmark button");
  const row = button && button.closest(".answmsg[data-op]");
  if (!row) return;
  e.stopPropagation();
  sentMarkAct(el, row.dataset.op, button.dataset.act);
}

// ---- one bubble for each send, and the bubbles coming together ------------------------
// the seat at the card's foot holds what has been sent as bubbles, oldest first,
// each a panel of its own (answeredPanel, the sheet's .answered.sent) with its
// own cut, arrow and mark. a message this page has just sent comes into a
// bubble of its own under the others, the one the flight above lands on. two
// bubbles side by side become one only when they stand in the same place, read
// off the newest message in each: both not delivered yet, both Delivered, or
// both Read (the owner's rule). while
// they differ they stay two, each under its own word. once they match, the word
// under the earlier bubble fades out, and the moment it is gone the earlier
// bubble falls into the later one while the word comes in under it (sentMove,
// sentMerge).
// a bubble once joined stays one, whatever its messages do next, and carries
// the one word sentTagOf gives it. what a reading brings that this page did
// not send is no arrival and moves nothing: it joins the bubble before it at
// once when it stands where that bubble stands, and has a bubble of its own
// when it does not; a first draw gives every run of messages standing in one
// place one bubble. a reader who asked for no motion, or a seat not on screen,
// has the two become one at once, with nothing moving, when the rule says so.
// el.sent is the newest bubble, the one at the foot

// the bubbles standing in a card's seat, oldest first, and the rows of one
function sentPanels(el){
  if (!el || !el.sentwrap) return [];
  return [...el.sentwrap.children].filter(node => node.classList && node.classList.contains("answered"));
}
function sentRows(panel){
  const stack = panel.querySelector(".answstack");
  return stack ? [...stack.children] : [];
}
// where a message stands, the owner's three places: not delivered yet, and the
// two words a mark says. a board too old to say leaves it nowhere, which is a
// place of its own
function sentState(m){ return m.stage === "local" ? "local" : SENT_TAGS[m.stage] || ""; }
// and where a bubble stands: where its newest message does
function sentStands(shown){ return shown && shown.length ? sentState(shown[shown.length - 1]) : null; }

// the messages shown, shared out into bubbles. before is the messages of each
// bubble standing, oldest first; own is the message this page has just sent,
// or null for a reading. what stood keeps its bubble, matched by its words in
// order; a new message that lands between two messages of one bubble joins it;
// own starts a bubble of its own; any other new message joins the bubble
// before it when it stands where the message before it stands, and starts one
// of its own when it does not. answers each group's id, which names the
// standing bubble it is when it is under before.length
function sentGroups(before, shown, own){
  const old = [];
  before.forEach((msgs, id) => { for (const m of msgs) old.push({ text:answeredText(m), id }); });
  const now = shown.map(answeredText);
  // the longest run of words the two lists share, in order
  const n = old.length, k = now.length;
  const table = Array.from({ length:n + 1 }, () => new Array(k + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = k - 1; j >= 0; j--)
      table[i][j] = old[i].text === now[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const matched = new Array(k).fill(-1);
  for (let i = 0, j = 0; i < n && j < k;){
    if (old[i].text === now[j]){ matched[j] = old[i].id; i++; j++; }
    else if (table[i + 1][j] >= table[i][j + 1]) i++;
    else j++;
  }
  const groups = [], ids = [];
  let fresh = before.length;
  shown.forEach((m, j) => {
    let id = matched[j];
    if (id < 0){
      const prev = j ? ids[j - 1] : null;
      const next = matched.slice(j + 1).find(one => one >= 0);
      if (prev !== null && prev === next) id = prev;
      else if (m !== own && prev !== null && sentState(m) === sentState(shown[j - 1])) id = prev;
      else id = fresh++;
    }
    ids.push(id);
    if (!groups.length || groups[groups.length - 1].id !== id) groups.push({ id, msgs:[] });
    groups[groups.length - 1].msgs.push(m);
  });
  return groups;
}

// a new bubble: the answered panel, telling its room, and asking for the next
// merge whenever its own run or its word has stopped moving
function sentBubble(el, room){
  const panel = answeredPanel(() => { if (room) room(); sentCoalesce(el); });
  panel.classList.add("sent");
  panel.addEventListener("click", e => sentBadgePress(el, e));
  panel.sentMsgs = [];
  panel.sentAgain = () => sentCoalesce(el);
  return panel;
}
function sentDropPanel(panel){
  panel.answRun = (panel.answRun || 0) + 1;   // a run still going lands on nothing
  if (panel.answWatch) panel.answWatch.disconnect();
  panel.remove();
}

// the messages this page sent that did not get through (el.sentHeld) stand in
// the seat after what the board has, since a reading of the board knows
// nothing of them. what a run of messages is drawn from: the words, and the
// state, the badge and the stage of each
function sentKeyOf(msgs){
  return JSON.stringify(msgs.map(m => [answeredText(m), m.op || "", m.state || "", m.badge || "", m.stage || ""]));
}
function syncSent(el, batch, arrive){
  if (!el || !el.sentwrap) return;
  const shown = (batch || []).concat(el.sentHeld || []).filter(m => !ANSWERED_BLANK.test(answeredText(m)));
  if (!shown.length){ dropSent(el); return; }
  // a pass bringing the same again touches no dom
  const key = sentKeyOf(shown);
  if (el.sent && el.sentKey === key) return;
  el.sentKey = key;
  const room = el.sentRoom || null;
  const own = arrive ? (batch || []).filter(m => !ANSWERED_BLANK.test(answeredText(m))).at(-1) || null : null;
  const standing = sentPanels(el);
  const groups = sentGroups(standing.map(panel => panel.sentMsgs || []), shown, own);
  // a merge in the middle of its fall goes on under a pass that leaves the
  // bubble it draws in holding the same messages, each as it was, as a send
  // after them does; any other pass lands it first and draws over it
  const falling = el.sentMerge && el.sentMerge.stage === "merge" ? el.sentMerge.a : null;
  if (falling){
    const kept = groups.find(group => group.id === standing.indexOf(falling));
    if (!kept || sentKeyOf(kept.msgs) !== sentKeyOf(falling.sentMsgs || [])) sentMergeLand(el);
  }
  const drawn = [];
  let fresh = null;   // the bubble this page's send comes into
  groups.forEach((group, i) => {
    let panel = group.id < standing.length ? standing[group.id] : null;
    const born = !panel;
    if (born){
      panel = sentBubble(el, room);
      const later = groups.slice(i + 1).find(one => one.id < standing.length);
      if (later) el.sentwrap.insertBefore(panel, standing[later.id]);
      else el.sentwrap.appendChild(panel);
      if (own && group.msgs.includes(own)){
        fresh = panel;
        // the flight shows the bubble; its word waits for the landing
        if (el.sentMotion) panel.classList.add("sentflight");
      }
    }
    panel.sentMsgs = group.msgs;
    drawn.push({ panel, born });
  });
  for (const panel of standing) if (!drawn.some(one => one.panel === panel)) sentDropPanel(panel);
  el.sent = drawn[drawn.length - 1].panel;
  const merging = el.sentMerge;
  drawn.forEach(({ panel, born }, i) => {
    stackAnswered(panel, panel.sentMsgs);
    // a bubble standing where the one above it stands waits to join it, and its
    // word with it; a merge under way holds its bubbles' words itself
    if (!merging || !merging.panels.includes(panel))
      panel.markHeld = i > 0 && sentStands(drawn[i - 1].panel.sentMsgs) === sentStands(panel.sentMsgs);
    sentMarks(panel, panel.sentMsgs, !born);
    fitAnswered(panel);
  });
  if (fresh && !el.sentMotion) arriveSent(fresh);
  // a send cuts back a bubble standing open on the fold's own run, so what has
  // just been sent always stands under bubbles cut to their preview; the run
  // tells the room itself once it has landed
  if (own) for (const { panel } of drawn) if (panel !== fresh && panel.classList.contains("open")) openAnswered(panel, false);
  if (room) room();
  sentCoalesce(el);
}

// the arrival's dress, taken off again by the clock rather than by the end of
// the animation, so a reader who has asked for no motion, whose page runs none,
// is not left holding it
function arriveSent(node){
  node.classList.add("arrive");
  setTimeout(() => node.classList.remove("arrive"), SENT_ARRIVE_MS + 60);
}

function dropSent(el){
  if (!el) return;
  for (const motion of [...(el.sentMotions || [])]) motion.cancel();
  sentMergeStop(el);
  const panels = sentPanels(el);
  if (!el.sent && !panels.length) return;
  for (const panel of panels) sentDropPanel(panel);
  el.sent = null;
  el.sentKey = "";
  if (el.sentRoom) el.sentRoom();
}

// ---- the merge ---------------------------------------------------------------------------
// the order is the owner's: the later bubble has landed and stands where the
// earlier one stands; the word under the earlier one fades out (MERGE_OUT_MS,
// gentler than a word giving way to the next), and the moment it is gone the
// earlier bubble starts to fall, gently, into the later one (MERGE_MS), while
// the word comes in under the later one on the mark's own run (MERGE_IN_MS).
// two bubbles with no word to fade, neither delivered yet, wait the same
// MERGE_OUT_MS and fall the same way. the send's flight is 650ms and the
// earlier messages glide in 340ms; the merge is longer than either, since what
// it shows is a change of shape the eye has to follow, not a thing arriving:
// the earlier bubble falls over the merge's first four fifths and the joint
// settles over the last. from the moment the later bubble matches to the
// moment it is one, 1.3s.
// the fall: the earlier bubble moves straight down, keeping its height, on a
// curve with no speed at its start and none at its landing, and nothing past
// it (FALL_EASE); the later bubble stands where it is. as the earlier one
// nears, its foot and the later one's head each bulge toward the other, the
// bulges meet in the middle of the side they share, a neck forms there and
// widens to the whole side as the foot sinks into the later bubble, the
// narrower one flows out to the wider's width, and the joint settles into
// one rounded bubble with nothing over or under it. the outline is drawn on every
// frame as one clip path over a plain grey face (sentGooPath), the smooth union
// of the two rounded boxes, so it is exactly the two boxes on the first frame
// and exactly the joined bubble on the last. no blur, filter or mask: a blur
// and threshold is what costs a phone's frames. the words ride on copies of
// the two bubbles (sentSnapshot) to their places in the joined one, which is
// already laid out, hidden, under them, and a copy of the joined bubble comes
// up over the last fifth, so a merge that ends past its preview's cut
// dissolves the new words into the cut and brings its arrow in rather than
// switching to it
const MERGE_OUT_MS = 300;
const MERGE_IN_MS = 400;    // MARK_IN_MS, the sheet's --answ-come
const MERGE_MS = 1000;
// the earlier bubble falls over the first four fifths, and the joint settles
// over the last
const MERGE_TRAVEL = .8;
// how far it has fallen: from no speed, so it sets off softly, to no speed at
// its landing, which it never passes (both handles stay inside the unit box).
// a tenth of the way down at 143ms and half way at 281ms, where the curve
// below is at 211ms and 370ms, so the fall is seen to start as the word goes
const FALL_EASE = [.4, 0, .2, 1];
const FALL_CURVE = sentCurve(FALL_EASE);
// the curve two bubbles came together on before the earlier one fell: slow to
// start and long to settle, with nothing past the end. the tab joint in
// index.html runs its own join on it
const MERGE_EASE = [.6, 0, .3, 1];

// a flight, a fold or a word going out is let finish first; whoever ends it
// asks again
function sentBusy(panel){
  return panel.classList.contains("sentflight") || panel.classList.contains("motion") ||
    panel.classList.contains("markout");
}
// the next two bubbles that may become one, if any, and if nothing else is
// moving them: the move of the word and then the merge, or both at once with
// nothing moving where motion cannot be shown
function sentCoalesce(el){
  if (!el || !el.sentwrap || el.sentMerge) return;
  const panels = sentPanels(el);
  for (let i = 1; i < panels.length; i++){
    const a = panels[i - 1], b = panels[i];
    // a bubble with nothing known to stand in is no one's to join
    const stands = sentStands(a.sentMsgs);
    if (stands === null || stands !== sentStands(b.sentMsgs)) continue;
    if (stillMotion() || typeof requestAnimationFrame !== "function" || !sentMotionVisible(a) || !sentMotionVisible(b)){
      // at once, with nothing moving: only a flight or a fold still going is waited for
      if ([a, b].some(one => one.classList.contains("sentflight") || one.classList.contains("motion"))) return;
      sentJoin(el, a, b);
      if (el.sentRoom) el.sentRoom();
      sentCoalesce(el);
      return;
    }
    // three or more standing in one place fall together, once none is busy
    const column = sentColumnOf(panels, i - 1);
    if (column.length > 2 && column.every(sentMotionVisible)){
      if (column.some(sentBusy)) return;
      sentColumnMove(el, column);
      return;
    }
    if (sentBusy(a) || sentBusy(b)) return;
    sentMove(el, a, b);
    return;
  }
}

// the later bubble's messages go into the earlier one, and the later one goes.
// the joined bubble's word is set at once: its move has already been shown
function sentJoin(el, a, b){
  const msgs = a.sentMsgs.concat(b.sentMsgs);
  a.sentMsgs = msgs;
  sentDropPanel(b);
  stackAnswered(a, msgs);
  a.classList.remove("markout", "markmove");
  a.markHeld = false;
  sentMarks(a, msgs, false);
  const panels = sentPanels(el), i = panels.indexOf(a);
  a.markHeld = i > 0 && sentStands(panels[i - 1].sentMsgs) === sentStands(msgs);
  fitAnswered(a);
  el.sent = panels[panels.length - 1];
}

// the word goes first. both bubbles take the grey the joined one is drawn in
// on the panel's own run, and the earlier one's word fades out (and the later
// one's too, when it says something else). the moment it is gone, or as long
// after the two matched when there was no word to go, the earlier bubble
// starts to fall into the later one and the joined bubble's word comes in
// under it as it falls, if the two still stand in one place and nothing else
// has taken them
function sentMove(el, a, b){
  const run = el.sentMerge = { a, b, panels:[a, b], stage:"move", timers:[], shifts:[] };
  a.markHeld = b.markHeld = true;
  a.classList.add("coalesce");
  const msgs = a.sentMsgs.concat(b.sentMsgs);
  const tag = sentTagOf(msgs);
  const faded = msgs.every(sentUndelivered);
  for (const one of [a, b]) one.classList.toggle("undelivered", faded);
  const later = (ms, fn) => run.timers.push(setTimeout(() => { if (el.sentMerge === run) fn(); }, ms));
  const going = [a, b].filter(one => one.dataset.mark && (one === a || one.dataset.mark !== tag));
  for (const one of going){
    one.classList.remove("markin");
    one.classList.add("markout", "markmove");
  }
  later(MERGE_OUT_MS, () => {
    for (const one of going){
      one.classList.remove("markout", "markmove");
      showMark(one, "", false);
    }
    const panels = sentPanels(el);
    if (panels.indexOf(b) !== panels.indexOf(a) + 1 || panels.indexOf(a) < 0 ||
        sentStands(a.sentMsgs) !== sentStands(b.sentMsgs) || sentBusy(a) || sentBusy(b)){
      sentMoveBack(el);
      return;
    }
    if (stillMotion() || !sentMotionVisible(a) || !sentMotionVisible(b)){
      sentMergeStop(el);
      sentJoin(el, a, b);
      if (el.sentRoom) el.sentRoom();
      sentCoalesce(el);
      return;
    }
    if (sentColumnGrown(el, run)) return;
    sentMerge(el, run);
  });
}
// a move whose bubbles no longer match, or that something else has taken: each
// keeps its own word again, and the next merge is looked for
function sentMoveBack(el){
  const run = el.sentMerge;
  if (!run) return;
  sentMergeStop(el);
  const panels = sentPanels(el);
  for (const one of run.panels){
    if (!one.isConnected) continue;
    const i = panels.indexOf(one);
    one.markHeld = i > 0 && sentStands(panels[i - 1].sentMsgs) === sentStands(one.sentMsgs);
    sentMarks(one, one.sentMsgs, true);
  }
  sentCoalesce(el);
}
// whatever stage a merge is at, it stops now: a move's clocks are let go, and a
// merge in motion lands where it is going
function sentMergeStop(el){
  const run = el && el.sentMerge;
  if (!run) return;
  if (run.stage === "merge"){ sentMergeLand(el); return; }
  el.sentMerge = null;
  for (const timer of run.timers) clearTimeout(timer);
  for (const one of run.panels) one.classList.remove("coalesce", "markout", "markmove");
}

// the merge itself. the joined bubble is laid out at once, where it will
// stand, and hidden; a layer inside it carries the motion: the grey face, the
// copies of the two bubbles' words, a copy of the word under them and a copy of
// the joined bubble, all in the joined bubble's own px, so the layer moves with
// it if anything moves it. the room the two give up above them is held by the
// seat's own ground, which comes down with the earlier bubble's head, and the
// other bubbles the merge moves glide there on the fall's own curve. the word
// the move brings in under the later bubble comes in here, on the mark's run.
// a joined bubble that is cut has its cut, fuzz and arrow stand still under
// the words the whole way (sentMergeFoot)
function sentMerge(el, run){
  const { a, b } = run;
  run.stage = "merge";
  const A = a.getBoundingClientRect(), B = b.getBoundingClientRect();
  const aRow = sentRows(a)[0], bRow = sentRows(b)[0];
  const aFrom = aRow.getBoundingClientRect(), bFrom = bRow.getBoundingClientRect();
  const look = getComputedStyle(a);
  const fill = look.backgroundColor;
  const ground = look.getPropertyValue("--card").trim() || "#fff";
  const corner = parseFloat(look.borderTopLeftRadius) || 0;
  // the joined bubble's word, which comes in unless it stands under the later one already
  const word = sentTagOf(a.sentMsgs.concat(b.sentMsgs));
  const comes = !!word && b.dataset.mark !== word;
  const seatFrom = el.sentwrap.getBoundingClientRect();
  // the other bubbles the merge moves; the answer stands still (sentKeepScroll)
  const around = sentPanels(el).filter(one => one !== a && one !== b)
    .filter(node => sentMotionVisible(node)).map(node => ({ node, rect:node.getBoundingClientRect() }));
  const aCopy = sentSnapshot(a, true), bCopy = sentSnapshot(b, true);
  const count = a.sentMsgs.length;
  // the later bubble's foot, and the earlier one's cut under its head if it is cut
  const bFoot = sentFootOf(b), aFoot = sentFootOf(a);
  const aCut = aFoot.cut ? A.height / sentScale(a, A).y - aFoot.rise : null;
  sentJoin(el, a, b);
  const M = a.getBoundingClientRect(), s = sentScale(a, M);
  const rows = sentRows(a);
  const aTo = rows[0].getBoundingClientRect();
  const joint = rows[count] || null;
  const bTo = joint ? joint.getBoundingClientRect() : null;
  const jointPad = joint ? parseFloat(getComputedStyle(joint).paddingTop) || 0 : 0;
  const cut = a.querySelector(".answclip").getBoundingClientRect();
  const seatTo = el.sentwrap.getBoundingClientRect();
  const mCopy = sentSnapshot(a, true);
  // the joined bubble's own px
  const x = v => (v - M.left) / s.x, y = v => (v - M.top) / s.y;
  const W = M.width / s.x, H = M.height / s.y, r = corner;
  const U0 = { left:x(A.left), top:y(A.top), right:x(A.right), bottom:y(A.bottom) };
  const L0 = { left:x(B.left), top:y(B.top), right:x(B.right), bottom:y(B.bottom) };
  // the later words' first line in the joined bubble, and whether the cut hides it
  const textTo = bTo ? y(bTo.top) + jointPad : H;
  const hidden = !bTo || bTo.top + jointPad * s.y >= cut.bottom - 1;
  // the joined bubble is laid out up from the later one's foot, so the later
  // bubble stands where it is: its box ends where it starts, flowed out to the
  // joined bubble's width. the earlier one falls until its head is the joined
  // bubble's head, its foot sunk into the later one by a corner each way past
  // that one's own head, so the joint is gone once it has landed
  const L1 = { left:0, top:Math.max(0, Math.min(L0.top, H - 2 * r)), right:W, bottom:H };
  const U1 = { left:0, top:0, right:W, bottom:Math.min(H, Math.max(U0.bottom - U0.top, L1.top + 2 * r)) };
  const aStart = { x:U0.left, y:U0.top };
  const aEnd = { x:x(aTo.left) - (aFrom.left - A.left) / s.x, y:y(aTo.top) - (aFrom.top - A.top) / s.y };
  // words the cut will hide stay where they stood and fade as the earlier
  // bubble sinks over them, rather than travelling to a place under the cut
  const bStart = { x:L0.left, y:L0.top };
  const bEnd = bTo && !hidden ? { x:x(bTo.left) - (bFrom.left - B.left) / s.x, y:textTo - (bFrom.top - B.top) / s.y } : bStart;
  // the layer
  const layer = document.createElement("div");
  layer.className = "sentgoo";
  layer.setAttribute("aria-hidden", "true");
  layer.style.width = W + "px";
  layer.style.height = H + "px";
  layer.style.visibility = "visible";
  const ext = { left:Math.min(U0.left, L0.left, 0) - 4, top:Math.min(U0.top, 0) - 4,
    right:Math.max(U0.right, L0.right, W) + 4, bottom:Math.max(L0.bottom, H) + 4 };
  const face = document.createElement("div");
  face.className = "sentgoo-face";
  Object.assign(face.style, { left:ext.left + "px", top:ext.top + "px", width:(ext.right - ext.left) + "px",
    height:(ext.bottom - ext.top) + "px", background:fill });
  const holder = (copy, clear) => {
    const wrap = document.createElement("div");
    wrap.className = "sentgoo-words";
    if (clear) copy.style.background = "transparent";
    wrap.appendChild(copy);
    return wrap;
  };
  const aWords = holder(aCopy, true), bWords = holder(bCopy, true), joined = holder(mCopy, false);
  joined.style.opacity = "0";
  // the joined bubble's cut, fuzz and arrow, standing still under the words. an
  // earlier bubble that is cut over a later one that is not brings the arrow down
  const carried = aCut !== null && !bFoot.cut;
  const foot = sentMergeFoot(a, ext, bFoot, carried);
  const aClip = foot && aCut !== null && !carried ? aCopy.querySelector(".answclip") : null;
  if (foot){
    foot.quiet(bCopy);
    if (!carried) foot.hold(aWords);
    foot.hold(bWords);
    layer.append(face, ...foot.nodes);
    if (carried) layer.appendChild(aWords);
  } else layer.append(face, aWords, bWords);
  let mark = null;
  if (word){
    mark = document.createElement("div");
    mark.className = comes ? "sentgoo-mark markin" : "sentgoo-mark";
    mark.textContent = word;
    layer.appendChild(mark);
  }
  layer.appendChild(joined);
  // the seat's ground over the room above, which the seat no longer covers
  const rise = (seatFrom.top - seatTo.top) / s.y;
  const floor = document.createElement("div");
  floor.className = "sentgoo-ground";
  floor.style.background = ground;
  run.seatPosition = el.sentwrap.style.position;
  if (getComputedStyle(el.sentwrap).position === "static") el.sentwrap.style.position = "relative";
  el.sentwrap.prepend(floor);
  run.visibility = a.style.visibility;
  a.style.visibility = "hidden";
  a.classList.add("coalesce");
  a.appendChild(layer);
  Object.assign(run, { layer, floor });
  const spec = { U0, L0, U1, L1, r };
  const mix = (p, q, f) => p + (q - p) * f;
  const put = t => {
    const { U, L, k, bow, ey, ew, sunk } = sentMergeShape(spec, t);
    face.style.clipPath = 'path("' + sentGooPath(U, L, r, k, bow, ext) + '")';
    const ay = mix(aStart.y, aEnd.y, ey);
    aWords.style.transform = "translate(" + mix(aStart.x, aEnd.x, ew) + "px," + ay + "px)";
    // the later words keep their line until the earlier bubble lands on them
    bWords.style.transform = "translate(" + mix(bStart.x, bEnd.x, ew) + "px," + mix(bStart.y, bEnd.y, sunk) + "px)";
    // later words the joined bubble's cut hides go as the earlier foot sinks over
    // them, and are not drawn under it, where its arrow passes
    if (hidden){
      bWords.style.opacity = String(1 - sunk);
      bWords.style.clipPath = "inset(" + Math.max(0, U.bottom - bStart.y) + "px 0 0 0)";
    }
    if (foot){
      foot.place(L, sunk);
      if (aClip) foot.under(aClip, ay + aCut);
    }
    if (mark) mark.style.top = L.bottom + "px";
    joined.style.opacity = String(sentSmooth((t - MERGE_TRAVEL) / (1 - MERGE_TRAVEL)));
    const left = Math.min(0, rise * (1 - ey));
    floor.style.top = left + "px";
    floor.style.height = -left + "px";
    // and the answer's band with it (sentBand), told whenever it has come down a half pixel
    const held = -left * s.y;
    if (Math.abs(held - (run.held || 0)) >= .5 || (!held && run.held)){
      run.held = held;
      if (el.sentRoom) el.sentRoom();
    }
  };
  // the bubbles the merge moves glide down with the fall, on its own curve
  for (const { node, rect } of around){
    if (!sentMotionVisible(node) || typeof node.animate !== "function") continue;
    const after = node.getBoundingClientRect(), scale = sentScale(node, after);
    const dx = (rect.left - after.left) / scale.x, dy = (rect.top - after.top) / scale.y;
    if (Math.abs(dx) <= .5 && Math.abs(dy) <= .5) continue;
    const transform = getComputedStyle(node).transform || "none";
    run.shifts.push(node.animate(
      [{ transform:"translate(" + dx + "px," + dy + "px) " + (transform === "none" ? "" : transform) }, { transform }],
      { duration:MERGE_MS * MERGE_TRAVEL, easing:"cubic-bezier(" + FALL_EASE.join(",") + ")" }));
  }
  put(0);   // the two bubbles as they stood, before any frame
  const t0 = performance.now();
  const step = now => {
    run.raf = 0;
    if (el.sentMerge !== run) return;
    if (!a.isConnected || !sentMotionVisible(el.sentwrap) || stillMotion()){ sentMergeLand(el); sentCoalesce(el); return; }
    const t = Math.max(0, Math.min(1, (now - t0) / MERGE_MS));
    put(t);
    // the joined bubble takes over on the frame after the last one is drawn
    run.raf = requestAnimationFrame(t < 1 ? step : () => { sentMergeLand(el); sentCoalesce(el); });
  };
  run.raf = requestAnimationFrame(step);
}
// a bubble's foot as it stands, read before a merge takes it: whether it is
// cut, and how far its cut stands over its foot, in its own px
function sentFootOf(panel){
  const R = panel.getBoundingClientRect(), s = sentScale(panel, R);
  const clip = panel.querySelector(".answclip").getBoundingClientRect();
  return { cut:panel.classList.contains("more") && !panel.classList.contains("open"), rise:(R.bottom - clip.bottom) / s.y };
}
// the joined bubble's foot through a merge, when the joined bubble is cut: the
// line its words go under (its cut), the fuzz over that line and the arrow under
// it, drawn once in the merge's layer where the joined bubble has them, so they
// stand still through the merge rather than ride the copies of the words. the
// copies were drawn whole and each with its own cut, so the later words, which
// travel down to their place in the joined bubble, took their fuzz and their
// arrow a line under the joined bubble's foot, and words a cut hides stood on
// its arrow until the joined copy came up. the copies are drawn in a window
// cut at that line (hold), so no word is drawn over the arrow or under the
// bubble, and the copy of the bubble at the foot gives up its own fuzz and
// arrow (quiet). from is the bubble at the foot as it stood (sentFootOf): a cut
// one's foot is the joined one's already, and stays as it is; one that was not
// cut takes the joined foot as p goes from 0 to 1, the line coming up from its
// words' foot as the fuzz and the arrow come in. a copy with a cut of its own
// gives up its fuzz as its cut comes down into the joined one's (under), so
// the two are never drawn over each other. carried is a foot brought down by
// the bubble on top, cut over a bubble at the foot that was not: its own arrow
// is the one that lands at the joined foot, so the arrow here stays out of
// sight and that copy is drawn over the fuzz, whole, with its own cut. ext is
// the layer's reach, all in the joined bubble's own px. null when the joined
// bubble is not cut
function sentMergeFoot(a, ext, from, carried){
  if (!a.classList.contains("more") || a.classList.contains("open")) return null;
  const clip = a.querySelector(".answclip");
  const M = a.getBoundingClientRect(), s = sentScale(a, M);
  const rise = (M.bottom - clip.getBoundingClientRect().bottom) / s.y;
  const fade = parseFloat(getComputedStyle(clip, "::after").height) || 0;
  const win = document.createElement("div");
  win.className = "sentgoo-cut";
  Object.assign(win.style, { left:ext.left + "px", top:ext.top + "px", width:(ext.right - ext.left) + "px",
    height:(ext.bottom - ext.top) + "px" });
  const fuzz = document.createElement("div");
  fuzz.className = "sentgoo-fuzz";
  const strip = a.querySelector(".answfoot").cloneNode(true);
  // the arrow's own head under the strip's head: it comes in only as the line
  // the words go under clears it, so no word is drawn over it on its way in
  const chev = a.querySelector(".answchev");
  const head = (rise - (chev ? chev.getBoundingClientRect().height / s.y : 0)) / 2;
  const cleared = from.cut || rise <= from.rise ? 0 : Math.max(0, Math.min(1, (rise - head - from.rise) / (rise - from.rise)));
  let line = 0;
  return {
    nodes:[win, fuzz, strip],
    hold(holder){
      Object.assign(holder.style, { left:-ext.left + "px", top:-ext.top + "px" });
      win.appendChild(holder);
    },
    quiet(copy){
      const own = copy.querySelector(".answfoot"), cut = copy.querySelector(".answclip");
      if (own) own.style.visibility = "hidden";
      if (cut) cut.style.setProperty("--answ-shade", "0");
    },
    // L is the box at the foot of the merge at this frame
    place(L, p){
      const k = from.cut ? 1 : Math.max(0, Math.min(1, p));
      line = L.bottom - (from.rise + (rise - from.rise) * k);
      win.style.clipPath = "inset(0 0 " + Math.max(0, ext.bottom - line) + "px 0)";
      const across = { left:L.left + "px", width:(L.right - L.left) + "px" };
      Object.assign(fuzz.style, across, { top:(line - fade) + "px", opacity:String(k) });
      const shown = carried ? 0 : k >= 1 ? 1 : Math.max(0, (k - cleared) / (1 - cleared));
      Object.assign(strip.style, across, { top:(L.bottom - rise) + "px", opacity:String(shown) });
    },
    // a copy's own cut (its .answclip) standing at y this frame
    under(cut, y){
      const into = fade > 0 ? Math.max(0, Math.min(1, (y - (line - fade)) / fade)) : 1;
      cut.style.setProperty("--answ-shade", String(1 - into));
    }
  };
}
// the merge has landed, or is cut short: the layer and the ground go, and the
// joined bubble stands where they were drawn, with the word its record has now
function sentMergeLand(el){
  const run = el.sentMerge;
  if (!run || run.stage !== "merge") return;
  el.sentMerge = null;
  for (const timer of run.timers) clearTimeout(timer);
  if (run.raf) cancelAnimationFrame(run.raf);
  for (const shift of run.shifts) shift.cancel();
  if (run.layer) run.layer.remove();
  if (run.floor) run.floor.remove();
  if (run.seatPosition !== undefined) el.sentwrap.style.position = run.seatPosition;
  const panel = run.a;
  panel.style.visibility = run.visibility || "";
  panel.classList.remove("coalesce");
  setMark(panel, panel.dataset.tag || "", true);
  if (el.sentRoom && panel.isConnected) el.sentRoom();
}

// ---- a column falling together -----------------------------------------------------------
// three or more bubbles side by side standing in one place do not join two at
// a time (the owner's word): once the word under each has gone they all let go
// at the same moment and fall the way stacked blocks dropped together fall.
// each falls from rest on the same steady pull (COLUMN_PULL), so while they all
// fall they keep the room between them; the bubble at the foot stands where it
// is, as the later bubble of a pair does, and the one just above it lands on it
// first; each one above lands on the one below a moment later, the moments
// coming closer as the ones higher up have gathered more speed, so the column
// settles from the foot up. each lands with its head at the joined bubble's
// head and stops there, as a dropped block stops, and its joint with what it
// landed on settles over COLUMN_SETTLE_MS, as a pair's joint does over the
// last fifth of its merge. the outline is each neighbouring pair's own
// (sentGooPath), on a grey face of its own, the faces together their union.
// the words ride on copies of the bubbles. the top bubble's go to the joined
// bubble's head. those of a bubble in the middle land there with it and are
// gone from there before the one above lands: to their own place in the
// joined bubble, or, where its cut hides them, faded out from the moment their
// bubble touches what it lands on, so no two messages ever stand at the joined
// head together. the foot's go as a pair's later words do, as the one over
// it sinks onto them (in a column its words are always under the cut). the joined
// bubble's copy comes up once the top one has landed. two bubbles keep the
// pair's fall (sentMerge)
const COLUMN_PULL = 1.25e-3;      // px per ms, per ms, in the joined bubble's own px
// a column so tall its top would take longer than this falls on a harder pull instead
const COLUMN_LONGEST_MS = 900;
const COLUMN_SETTLE_MS = 200;
// the bubbles from the i-th down that stand where it stands
function sentColumnOf(panels, i){
  const stands = sentStands(panels[i].sentMsgs);
  let j = i;
  while (j + 1 < panels.length && sentStands(panels[j + 1].sentMsgs) === stands) j++;
  return panels.slice(i, j + 1);
}
// a move whose run has more bubbles standing with it than when it began, three
// or more and none busy, starts again as a column, so the newcomers' words go
// first too. answers whether it did
function sentColumnGrown(el, run){
  const panels = sentPanels(el), at = panels.indexOf(run.a);
  if (at < 0) return false;
  const column = sentColumnOf(panels, at);
  if (column.length <= run.panels.length || column.length < 3 ||
      column.some(one => sentBusy(one) || !sentMotionVisible(one))) return false;
  sentMergeStop(el);
  sentColumnMove(el, column);
  return true;
}
// the column's words go first, all at once, as a pair's do (sentMove)
function sentColumnMove(el, panels){
  const a = panels[0], b = panels[panels.length - 1];
  const run = el.sentMerge = { a, b, panels, stage:"move", timers:[], shifts:[] };
  for (const one of panels) one.markHeld = true;
  a.classList.add("coalesce");
  const msgs = panels.flatMap(one => one.sentMsgs);
  const tag = sentTagOf(msgs);
  const faded = msgs.every(sentUndelivered);
  for (const one of panels) one.classList.toggle("undelivered", faded);
  const later = (ms, fn) => run.timers.push(setTimeout(() => { if (el.sentMerge === run) fn(); }, ms));
  const going = panels.filter(one => one.dataset.mark && (one !== b || one.dataset.mark !== tag));
  for (const one of going){
    one.classList.remove("markin");
    one.classList.add("markout", "markmove");
  }
  later(MERGE_OUT_MS, () => {
    for (const one of going){
      one.classList.remove("markout", "markmove");
      showMark(one, "", false);
    }
    const now = sentPanels(el), at = now.indexOf(a), stands = sentStands(a.sentMsgs);
    if (at < 0 || panels.some((one, i) => now[at + i] !== one || sentStands(one.sentMsgs) !== stands || sentBusy(one))){
      sentMoveBack(el);
      return;
    }
    if (stillMotion() || !panels.every(sentMotionVisible)){
      sentMergeStop(el);
      for (const one of panels.slice(1)) sentJoin(el, a, one);
      if (el.sentRoom) el.sentRoom();
      sentCoalesce(el);
      return;
    }
    if (sentColumnGrown(el, run)) return;
    sentColumnMerge(el, run);
  });
}
// the column's fall, drawn as a pair's merge is drawn (sentMerge): the joined
// bubble laid out at once where it will stand, and hidden, with a layer in it
// carrying the faces, the words, the word under them, the joined bubble's copy
// and the seat's ground
function sentColumnMerge(el, run){
  const { a, panels } = run;
  run.stage = "merge";
  const n = panels.length, foot = panels[n - 1];
  const starts = panels.map(one => one.getBoundingClientRect());
  const froms = panels.map(one => sentRows(one)[0].getBoundingClientRect());
  const look = getComputedStyle(a);
  const fill = look.backgroundColor;
  const ground = look.getPropertyValue("--card").trim() || "#fff";
  const r = parseFloat(look.borderTopLeftRadius) || 0;
  const word = sentTagOf(panels.flatMap(one => one.sentMsgs));
  const comes = !!word && foot.dataset.mark !== word;
  const seatFrom = el.sentwrap.getBoundingClientRect();
  const around = sentPanels(el).filter(one => !panels.includes(one))
    .filter(node => sentMotionVisible(node)).map(node => ({ node, rect:node.getBoundingClientRect() }));
  const copies = panels.map(one => sentSnapshot(one, true));
  // the foot bubble's foot, and each bubble's cut under its head if it is cut
  const feet = panels.map(sentFootOf);
  const cuts = panels.map((one, i) => feet[i].cut ? starts[i].height / sentScale(one, starts[i]).y - feet[i].rise : null);
  // each bubble's first message among the joined bubble's rows
  const firsts = [];
  panels.reduce((count, one) => { firsts.push(count); return count + one.sentMsgs.length; }, 0);
  for (const one of panels.slice(1)) sentJoin(el, a, one);
  const M = a.getBoundingClientRect(), s = sentScale(a, M);
  const rows = sentRows(a);
  const cut = a.querySelector(".answclip").getBoundingClientRect();
  const seatTo = el.sentwrap.getBoundingClientRect();
  const mCopy = sentSnapshot(a, true);
  // the joined bubble's own px
  const x = v => (v - M.left) / s.x, y = v => (v - M.top) / s.y;
  const W = M.width / s.x, H = M.height / s.y;
  const B0 = starts.map(R => ({ left:x(R.left), top:y(R.top), right:x(R.right), bottom:y(R.bottom) }));
  const head = rows[0].getBoundingClientRect();
  // where each bubble's words stand once it has landed at the joined head, and
  // their own place in the joined bubble, or null where its cut hides them
  const offset = i => ({ x:(froms[i].left - starts[i].left) / s.x, y:(froms[i].top - starts[i].top) / s.y });
  const landed = panels.map((one, i) => ({ x:x(head.left) - offset(i).x, y:y(head.top) - offset(i).y }));
  const homes = panels.map((one, i) => {
    if (!i) return landed[0];
    const row = rows[firsts[i]];
    if (!row) return null;
    const R = row.getBoundingClientRect(), pad = parseFloat(getComputedStyle(row).paddingTop) || 0;
    if (R.top + pad * s.y >= cut.bottom - 1) return null;
    return { x:x(R.left) - offset(i).x, y:y(R.top) + pad - offset(i).y };
  });
  const plan = sentColumnPlan(B0, W, H, r);
  const { falls, last, end } = plan;
  // the layer
  const layer = document.createElement("div");
  layer.className = "sentgoo";
  layer.setAttribute("aria-hidden", "true");
  layer.style.width = W + "px";
  layer.style.height = H + "px";
  layer.style.visibility = "visible";
  const ext = { left:Math.min(0, ...B0.map(b => b.left)) - 4, top:Math.min(0, ...B0.map(b => b.top)) - 4,
    right:Math.max(W, ...B0.map(b => b.right)) + 4, bottom:Math.max(H, ...B0.map(b => b.bottom)) + 4 };
  const faces = falls.map(() => {
    const face = document.createElement("div");
    face.className = "sentgoo-face";
    Object.assign(face.style, { left:ext.left + "px", top:ext.top + "px", width:(ext.right - ext.left) + "px",
      height:(ext.bottom - ext.top) + "px", background:fill });
    return face;
  });
  const holder = (copy, clear) => {
    const wrap = document.createElement("div");
    wrap.className = "sentgoo-words";
    if (clear) copy.style.background = "transparent";
    wrap.appendChild(copy);
    return wrap;
  };
  const words = copies.map(copy => holder(copy, true)), joined = holder(mCopy, false);
  joined.style.opacity = "0";
  // the joined bubble's cut, fuzz and arrow, standing still under the words, as a
  // pair's do. a top bubble that is cut over a foot that is not brings the arrow down
  const carried = cuts[0] !== null && !feet[n - 1].cut;
  const still = sentMergeFoot(a, ext, feet[n - 1], carried);
  const clips = copies.map((copy, i) => still && i < n - 1 && cuts[i] !== null && !(carried && !i) ?
    copy.querySelector(".answclip") : null);
  if (still){
    still.quiet(copies[n - 1]);
    words.forEach((one, i) => { if (!(carried && !i)) still.hold(one); });
    layer.append(...faces, ...still.nodes);
    if (carried) layer.appendChild(words[0]);
  } else layer.append(...faces, ...words);
  let mark = null;
  if (word){
    mark = document.createElement("div");
    mark.className = comes ? "sentgoo-mark markin" : "sentgoo-mark";
    mark.textContent = word;
    layer.appendChild(mark);
  }
  layer.appendChild(joined);
  // the seat's ground over the room above, which the seat no longer covers
  const rise = (seatFrom.top - seatTo.top) / s.y;
  const floor = document.createElement("div");
  floor.className = "sentgoo-ground";
  floor.style.background = ground;
  run.seatPosition = el.sentwrap.style.position;
  if (getComputedStyle(el.sentwrap).position === "static") el.sentwrap.style.position = "relative";
  el.sentwrap.prepend(floor);
  run.visibility = a.style.visibility;
  a.style.visibility = "hidden";
  a.classList.add("coalesce");
  a.appendChild(layer);
  Object.assign(run, { layer, floor, end });
  const mix = (p, q, f) => p + (q - p) * f;
  const put = ms => {
    const state = sentColumnShape(plan, ms);
    state.boxes.forEach((box, i) => {
      if (i < n - 1) faces[i].style.clipPath = 'path("' +
        sentGooPath(box, state.boxes[i + 1], r, state.joints[i].k, state.joints[i].bow, ext) + '")';
    });
    if (still) still.place(state.boxes[n - 1], state.joints[n - 2].sunk);
    words.forEach((holderOf, i) => {
      const start = B0[i], home = homes[i];
      // sunk onto it by the one above, and its share of its own fall
      const over = i ? state.joints[i - 1].sunk : 0;
      let at, strength = 1;
      if (i === n - 1){
        const to = home || { x:start.left, y:start.top };
        at = { x:mix(start.left, to.x, state.ewFoot), y:mix(start.top, to.y, over) };
        // words the joined cut hides are not drawn under the one sinking over them
        if (!home){
          strength = 1 - over;
          holderOf.style.clipPath = "inset(" + Math.max(0, state.boxes[n - 2].bottom - at.y) + "px 0 0 0)";
        }
      } else {
        const fall = state.joints[i];
        const down = { x:mix(start.left, landed[i].x, fall.ew), y:mix(start.top, landed[i].y, fall.share) };
        at = down;
        if (i){
          // a middle bubble's words leave the joined head before the one above lands
          // there: to their own place in the joined bubble from their own landing,
          // or, where its cut hides them, gone from their own touch
          const mine = falls[i], above = falls[i - 1];
          const clear = from => sentSmooth((ms - from) / Math.max(1, above.lands - from));
          if (home){
            const go = clear(mine.lands);
            at = { x:mix(down.x, home.x, go), y:mix(down.y, home.y, go) };
          } else strength = 1 - clear(mine.touch);
        }
      }
      holderOf.style.transform = "translate(" + at.x + "px," + at.y + "px)";
      if (strength < 1 || holderOf.style.opacity) holderOf.style.opacity = String(strength);
      if (clips[i]) still.under(clips[i], at.y + cuts[i]);
    });
    if (mark) mark.style.top = state.boxes[n - 1].bottom + "px";
    joined.style.opacity = String(sentSmooth((ms - last) / COLUMN_SETTLE_MS));
    const left = Math.min(0, rise * (1 - state.joints[0].share));
    floor.style.top = left + "px";
    floor.style.height = -left + "px";
    const held = -left * s.y;
    if (Math.abs(held - (run.held || 0)) >= .5 || (!held && run.held)){
      run.held = held;
      if (el.sentRoom) el.sentRoom();
    }
  };
  // the bubbles above the column come down with its top one, on the same pull
  for (const { node, rect } of around){
    if (!sentMotionVisible(node) || typeof node.animate !== "function") continue;
    const now = node.getBoundingClientRect(), scale = sentScale(node, now);
    const dx = (rect.left - now.left) / scale.x, dy = (rect.top - now.top) / scale.y;
    if (Math.abs(dx) <= .5 && Math.abs(dy) <= .5) continue;
    const transform = getComputedStyle(node).transform || "none";
    run.shifts.push(node.animate(
      [{ transform:"translate(" + dx + "px," + dy + "px) " + (transform === "none" ? "" : transform) }, { transform }],
      { duration:falls[0].lands, easing:"cubic-bezier(" + COLUMN_EASE.join(",") + ")" }));
  }
  put(0);   // the bubbles as they stood, before any frame
  const t0 = performance.now();
  const step = now => {
    run.raf = 0;
    if (el.sentMerge !== run) return;
    if (!a.isConnected || !sentMotionVisible(el.sentwrap) || stillMotion()){ sentMergeLand(el); sentCoalesce(el); return; }
    const ms = Math.max(0, Math.min(end, now - t0));
    put(ms);
    // the joined bubble takes over on the frame after the last one is drawn
    run.raf = requestAnimationFrame(ms < end ? step : () => { sentMergeLand(el); sentCoalesce(el); });
  };
  run.raf = requestAnimationFrame(step);
}
// a fall from rest on a steady pull, as a css curve: the distance is the square
// of the time, exactly
const COLUMN_EASE = [1 / 3, 0, 2 / 3, 1 / 3];
// the column's fall worked out once, from where its bubbles stand (B0, top to
// foot, in the joined bubble's own px) and the joined bubble's width, height
// and corner. the foot stands, flowed out to the joined width; each bubble
// over it falls from rest until its head is the joined head, the one landing
// on the foot sunk into it by a corner each way past the foot's head, as a
// pair's is. for each: its drop, the room under it, where its foot meets what
// it lands on (under: the foot's head, or the joined head the one under it
// has landed at), the box it ends as (U1), the moment it lands and the moment
// its foot touches. last is when the top one lands, end when it has settled
function sentColumnPlan(B0, W, H, r){
  const n = B0.length, L0 = B0[n - 1];
  const L1 = { left:0, top:Math.max(0, Math.min(L0.top, H - 2 * r)), right:W, bottom:H };
  const falls = B0.slice(0, -1).map((U0, i) => {
    const onFoot = i === n - 2, tall = U0.bottom - U0.top;
    return { U0, tall, drop:Math.max(0, -U0.top), gap:Math.max(0, B0[i + 1].top - U0.bottom),
      under:onFoot ? L0.top : 0,
      U1:{ left:0, top:0, right:W, bottom:Math.min(H, Math.max(tall, (onFoot ? L1.top : 0) + 2 * r)) } };
  });
  const longest = Math.max(1, ...falls.map(f => f.drop));
  const pull = Math.max(COLUMN_PULL, 2 * longest / (COLUMN_LONGEST_MS * COLUMN_LONGEST_MS));
  const after = d => Math.sqrt(2 * Math.max(0, d) / pull);   // ms to fall d from rest
  for (const f of falls){
    f.lands = after(f.drop);
    f.touch = Math.min(f.lands, after(f.under - f.tall - f.U0.top));
  }
  const last = Math.max(...falls.map(f => f.lands));
  return { falls, L0, L1, W, r, pull, last, end:last + COLUMN_SETTLE_MS };
}
// the column at ms into its fall. for each bubble over the foot: its box, how
// far it has fallen as a share of its drop (share), how far it has flowed out
// to the joined width (ew, whole by its landing), how far its foot has sunk
// into what it landed on (sunk: from the touch to the end of its settling),
// and its joint with what is
// under it, bulging as the room between them closes (bow) and reaching across
// as they meet (k), let go as it settles, as a pair's are (sentMergeShape).
// the foot flows out as the one landing on it falls and settles
function sentColumnShape({ falls, L0, L1, r, pull }, ms){
  const mix = (p, q, f) => p + (q - p) * f;
  const boxes = [], joints = [];
  for (const f of falls){
    const fallen = ms >= f.lands ? f.drop : Math.min(f.drop, .5 * pull * ms * ms);
    const sunk = sentSmooth((ms - f.touch) / (f.lands - f.touch + COLUMN_SETTLE_MS));
    // flowed out by its landing, so the top one's words stand in their joined place
    // before the joined bubble's copy comes up over them, as a pair's do
    const ew = sentSmooth(ms / Math.max(1, f.lands));
    const top = f.U0.top + fallen;
    boxes.push({ left:mix(f.U0.left, f.U1.left, ew), right:mix(f.U0.right, f.U1.right, ew), top,
      bottom:top + f.tall + (f.U1.bottom - f.U1.top - f.tall) * sunk });
    joints.push({ share:f.drop > 0 ? fallen / f.drop : 1, ew, sunk, settle:sentSmooth((ms - f.lands) / COLUMN_SETTLE_MS) });
  }
  const onFoot = falls[falls.length - 1], footSunk = joints[joints.length - 1].sunk;
  const ewFoot = sentSmooth(ms / (onFoot.lands + COLUMN_SETTLE_MS));
  boxes.push({ left:mix(L0.left, L1.left, ewFoot), right:mix(L0.right, L1.right, ewFoot),
    top:mix(L0.top, L1.top, footSunk), bottom:mix(L0.bottom, L1.bottom, footSunk) });
  falls.forEach((f, i) => {
    const room = Math.max(0, boxes[i + 1].top - (boxes[i].top + f.tall));
    const near = f.gap > 0 ? 1 - Math.min(1, room / f.gap) : 1;
    const bulge = Math.max(4, .3 * f.gap), reach = Math.max(1.5 * r, 1.65 * f.gap);
    joints[i].bow = bulge * sentSmooth(near / .8) * (1 - sentSmooth(joints[i].sunk / .55));
    joints[i].k = reach * sentSmooth((near - .45) / .5) * (1 - joints[i].settle);
  });
  return { boxes, joints, ewFoot };
}

// the two bubbles at one moment t (0 to 1) of their merge: the earlier box U
// falling from where it stood (U0) to the joined bubble's head (U1), the later
// box L standing where it stood (L0, which L1 keeps but for its width), how
// far the sides they share bulge toward each other (bow) and how far their
// union reaches across (k). the earlier box falls over the first MERGE_TRAVEL
// and the joint settles over the rest, so the joined bubble's copy comes up
// over words that have already landed. it falls at its own height until its
// foot reaches the later one's head, and from there its foot sinks into the
// later one (sunk, 0 at the touch and 1 on landing) while its head lands, so
// nothing over the later bubble's head ever stretches. the bulging and the
// reach follow how near the two faces have come rather than the clock, so
// whatever the distance they swell toward each other, touch in the middle of
// the side they share before the faces meet, and the neck widens from there;
// the bulge lets go as the foot sinks and the reach over the last half, and
// the joint settles into one rounded bubble. ey is the fall, ew across: the
// narrower bubble flowing out to the wider's width, and its words, a shorter
// message's moving left to the joined bubble's edge, which go at the gentler
// pace the owner asked for:
// over the whole of the travel from a tenth in, 700ms, rather than 450ms from
// a fifth in, the fastest frame a little under two thirds as fast as it was
const MERGE_ACROSS_FROM = .1;
function sentMergeShape({ U0, L0, U1, L1, r }, t){
  const ey = FALL_CURVE(Math.min(1, t / MERGE_TRAVEL));
  const ew = sentSmooth((t - MERGE_ACROSS_FROM) / (MERGE_TRAVEL - MERGE_ACROSS_FROM));
  const mix = (p, q, f) => p + (q - p) * f;
  const across = (from, to) => ({ left:mix(from.left, to.left, ew), right:mix(from.right, to.right, ew) });
  const gap = Math.max(0, L0.top - U0.bottom);
  // the share of the fall at which the two faces would meet with no help
  const travel = (U1.top - U0.top) + (L0.top - L1.top);
  const meet = travel > 0 ? Math.min(1, gap / travel) : 0;
  const near = meet > 0 ? ey / meet : 1;
  const from = Math.min(meet, .9);
  const sunk = sentSmooth((ey - from) / (1 - from));
  const top = mix(U0.top, U1.top, ey), tall = U0.bottom - U0.top;
  const U = { ...across(U0, U1), top, bottom:top + tall + (U1.bottom - U1.top - tall) * sunk };
  const L = { ...across(L0, L1), top:mix(L0.top, L1.top, ey), bottom:mix(L0.bottom, L1.bottom, ey) };
  const bulge = Math.max(4, .3 * gap), reach = Math.max(1.5 * r, 1.65 * gap);
  const bow = bulge * sentSmooth(near / .8) * (1 - sentSmooth(sunk / .55));
  const k = reach * sentSmooth((near - .45) / .5) * (1 - sentSmooth((t - .4) / .45));
  return { U, L, k, bow, ey, ew, sunk };
}

// a css cubic-bezier as a function of its x, found by halving
function sentCurve([x1, y1, x2, y2]){
  const at = (p, q, t) => 3 * (1 - t) * (1 - t) * t * p + 3 * (1 - t) * t * t * q + t * t * t;
  return f => {
    if (f <= 0) return 0;
    if (f >= 1) return 1;
    let lo = 0, hi = 1;
    for (let i = 0; i < 30; i++){
      const t = (lo + hi) / 2;
      if (at(x1, x2, t) < f) lo = t; else hi = t;
    }
    return at(y1, y2, (lo + hi) / 2);
  };
}
function sentSmooth(p){
  const t = Math.max(0, Math.min(1, p));
  return t * t * (3 - 2 * t);
}
// how far a point stands outside a rounded box: below nothing, inside
function sentBoxDistance(x, y, b, r){
  const hx = (b.right - b.left) / 2, hy = (b.bottom - b.top) / 2;
  if (!(hx > 0 && hy > 0)) return Infinity;
  const c = Math.min(r, hx, hy);
  const qx = Math.abs(x - b.left - hx) - hx + c, qy = Math.abs(y - b.top - hy) - hy + c;
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - c;
}
// where a row crosses one rounded box, or null
function sentBoxRow(b, r, y){
  if (y < b.top || y > b.bottom) return null;
  const c = Math.min(r, (b.right - b.left) / 2, (b.bottom - b.top) / 2);
  const d = y < b.top + c ? b.top + c - y : y > b.bottom - c ? y - b.bottom + c : 0;
  const inset = c - Math.sqrt(Math.max(0, c * c - d * d));
  return [b.left + inset, b.right - inset];
}
// one rounded box as path data, clockwise
function sentBoxPath(b, r, px, py){
  const w = b.right - b.left, h = b.bottom - b.top;
  if (!(w > 0 && h > 0)) return "";
  const c = Math.min(r, w / 2, h / 2), arc = "A" + c + " " + c + " 0 0 1 ";
  return "M" + px(b.left + c) + " " + py(b.top) + "H" + px(b.right - c) + arc + px(b.right) + " " + py(b.top + c) +
    "V" + py(b.bottom - c) + arc + px(b.right - c) + " " + py(b.bottom) + "H" + px(b.left + c) +
    arc + px(b.left) + " " + py(b.bottom - c) + "V" + py(b.top + c) + arc + px(b.left + c) + " " + py(b.top) + "Z";
}
// the two bubbles' outline at one moment of the merge, as path data in the
// face's own px (ext is the face's box): U the earlier, L the later, r their
// corner, k the reach of their smooth union and bow how far the sides they
// share bulge toward each other. with neither, it is the two boxes as they
// are. with them, the outline is found row by row, half a pixel apart, where
// the two can touch, and is the boxes' own above and below that band; the
// union is never let out past the two boxes' outer sides, so the joint
// fills in but never swells past the column's edge
function sentGooPath(U, L, r, k, bow, ext){
  const px = v => (v - ext.left).toFixed(2), py = v => (v - ext.top).toFixed(2);
  if (k < .01 && bow < .01) return sentBoxPath(U, r, px, py) + sentBoxPath(L, r, px, py);
  const right = Math.max(U.right, L.right), left = Math.min(U.left, L.left);
  const shared = Math.max(U.left, L.left), middle = (shared + right) / 2, span = Math.max(1, (right - shared) / 2);
  const uMid = (U.top + U.bottom) / 2, uHalf = Math.max(1, (U.bottom - U.top) / 2);
  const lMid = (L.top + L.bottom) / 2, lHalf = Math.max(1, (L.bottom - L.top) / 2);
  // the reach is the joint's alone: whole within three quarters of a corner of
  // the two faces, and gone a corner and three quarters away, so a narrower
  // bubble's far corners keep their own round while it flows out to the
  // wider's width
  // neither the reach nor the bulge comes into the rows of the outline's head
  // and foot corners, and both come in over a corner's length past them: on a
  // short bubble the joint's reach ran down to its foot, swelled the corner
  // there out past the foot row and the column's side, and the trace cut it
  // square there, and in a column two bubbles at the joined head bulged at it
  const faceTop = Math.min(U.bottom, L.top), faceFoot = Math.max(U.bottom, L.top);
  const top = Math.min(U.top, L.top), bottom = Math.max(U.bottom, L.bottom);
  const clear = fy => sentSmooth((Math.min(fy - top, bottom - fy) - r) / r);
  const reachAt = fy => k * (1 - sentSmooth((Math.max(0, faceTop - fy, fy - faceFoot) - .75 * r) / r)) * clear(fy);
  // nor does the reach come into the columns of the corners a bubble stands
  // out past the other's side with, which the side would cut square too: they
  // are kept whole as far as it stands out by a corner, and blend again as the
  // narrower one flows out
  const keep = [];
  const standsOut = (by, x) => { if (by > 0) keep.push([x, sentSmooth(by / r)]); };
  standsOut(Math.abs(L.left - U.left), left);
  standsOut(Math.abs(U.right - L.right), right - r);
  const kept = fx => keep.reduce((f, [x, s]) => f * (1 - s * (1 - sentSmooth(Math.max(x - fx, 0, fx - x - r) / r))), 1);
  const field = (fx, fy) => {
    const u = (fx - middle) / span, swell = u * u < 1 ? bow * (1 - u * u) * (1 - u * u) * clear(fy) : 0;
    const du = sentBoxDistance(fx, fy, U, r) - (swell ? swell * Math.max(0, Math.min(1, (fy - uMid) / uHalf)) : 0);
    const dl = sentBoxDistance(fx, fy, L, r) - (swell ? swell * Math.max(0, Math.min(1, (lMid - fy) / lHalf)) : 0);
    let d = Math.min(du, dl);
    const kk = reachAt(fy) * kept(fx);
    if (kk > 0){
      const h = Math.max(kk - Math.abs(du - dl), 0) / kk;
      d -= h * h * kk / 4;
    }
    return Math.max(d, fx - right, left - fx);
  };
  const near = r + k / 2 + bow + 2;
  const from = Math.min(U.bottom, L.top) - near, to = Math.max(U.bottom, L.top) + near;
  const loops = [];
  let loop = null;
  for (let fy = top + .01; ; fy = Math.min(fy + .5, bottom - .01)){
    let across = null;
    if (fy < from) across = sentBoxRow(U, r, fy);
    else if (fy > to) across = sentBoxRow(L, r, fy);
    else {
      let inside = null, low = Infinity;
      for (let i = 0; i <= 12; i++){
        const fx = i < 10 ? left + (right - left) * (i + .5) / 10 : i === 10 ? middle : i === 11 ? (U.left + U.right) / 2 : (L.left + L.right) / 2;
        const f = field(fx, fy);
        if (f < low){ low = f; inside = fx; }
      }
      if (low < 0){
        let out = left - 1, inn = inside;
        for (let i = 0; i < 16; i++){ const m = (out + inn) / 2; if (field(m, fy) < 0) inn = m; else out = m; }
        let inn2 = inside, out2 = right + 1;
        for (let i = 0; i < 16; i++){ const m = (inn2 + out2) / 2; if (field(m, fy) < 0) inn2 = m; else out2 = m; }
        across = [inn, inn2];
      }
    }
    if (across){
      if (!loop) loops.push(loop = []);
      loop.push([fy, across[0], across[1]]);
    } else loop = null;
    if (fy >= bottom - .01) break;
  }
  // each loop down its left side and back up its right, a straight side kept
  // to its two ends
  return loops.map(rows => {
    const points = rows.map(([fy, l]) => [l, fy]).concat(rows.slice().reverse().map(([fy, , rr]) => [rr, fy]));
    const kept = points.filter((p, i) => i === 0 || i === points.length - 1 ||
      !(Math.abs(points[i - 1][0] - p[0]) < 1e-3 && Math.abs(points[i + 1][0] - p[0]) < 1e-3));
    return "M" + kept.map(([fx, fy]) => px(fx) + " " + py(fy)).join("L") + "Z";
  }).join("");
}

// the band the answer is cut to at the sent bubbles' top edge: what the page
// measured, on every frame a bubble opens or is cut back on too. it used to be
// held at the lower of a run's two ends, so the answer's fade was not drawn
// again on every frame of the run; but then the fade stood under the seat for
// the whole of an opening and went up in one frame once the bubble stood open,
// the white over it growing upward all at once, and came down in one frame as
// a cut back set off (the owner's recording).
// following the bubble, the fade rides its top edge the whole way
// and nothing changes once it has stopped. band is what the page measured;
// what comes back is what it should write. while one bubble falls into the
// next the seat already stands at its joined height, and the band is held
// down by the room the falling bubble's head has still to come down (the
// seat's ground over it, run.held, in the page's px), so the fade comes down
// with the head rather than dropping the whole way on the fall's first frame
function sentBand(el, band){
  const run = el.sentMerge;
  if (run && run.stage === "merge" && run.held) band = Math.round(band + run.held);
  sentKeepScroll(el, band);
  return band;
}
// the answer stands still under the bubbles, whatever they do: it is a thing
// of its own, and nothing the bubbles do is a reason for it to move (the
// owner's word). the band is also the
// depth of the run-out at the foot of the answer's scroll, so a band coming
// down, as two bubbles join or one is cut back, shortened the scroll, and a
// reader standing at the very end of the answer was pulled down with it in
// one frame. the room the band gives up is held under the answer instead, and
// let go of a frame later, once the new band stands, as far as the reader is
// not standing on it (holdSlack, trimSlack)
function sentKeepScroll(el, band){
  const view = el.replyview, was = el.sentBandWas;
  el.sentBandWas = band;
  if (!view || was == null || !(band < was)) return;
  holdSlack(view, heldSlack(view) + was - band);
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => trimSlack(view));
}

// ---- the board's refresh and the card's own motion ------------------------------------
// a panel's run and the glide of a page turn are the card's own motion, and the
// board's timed refresh waits them out. a refresh is a whole pass over every
// card on the page's one thread, and one landing inside a third of a second of
// motion costs that motion frames it never gets back. only the timed refresh
// waits, and only until the motion is over; a refresh asked for by something the
// reader did goes at once
function cardsMoving(){
  return typeof document !== "undefined" && typeof document.querySelector === "function" &&
    !!document.querySelector(".answered.motion, .answered.sentflight, .answered.coalesce, .answered.markin, .answered.markout, .answered.markgone, .turnsheet");
}

// ---- a still copy, for the fade between projects ---------------------------------------
// both pages fade the project being left out over the one arriving, and the
// one being left is the same set of boxes the new one is drawn into, so what
// fades out is a copy of it taken just before the switch. a copy keeps the
// markup and none of what lives beside it, so the typed text and a drawing are
// carried over by hand, and the scroll is carried once the copy is on the
// page (settle). a framed page is left out, since a copy would load and run
// it a second time, and a player is told not to fetch or play anything. the
// copy takes no click, no key and no focus. noIds takes every id off it, for
// a copy that stands somewhere the page's own ids could find it
function stillCopy(el, { noIds = false } = {}){
  const copy = el.cloneNode(true);
  copy.inert = true;
  copy.setAttribute("aria-hidden", "true");
  const live = [el, ...el.querySelectorAll("*")], dup = [copy, ...copy.querySelectorAll("*")], scrolls = [];
  for (let i = 0; i < live.length; i++){
    const a = live[i], b = dup[i];
    if (a.scrollTop || a.scrollLeft) scrolls.push([b, a.scrollTop, a.scrollLeft]);
    if (noIds) b.removeAttribute("id");
    if (a.tagName === "TEXTAREA" || a.tagName === "INPUT"){ b.value = a.value; b.checked = a.checked; }
    else if (a.tagName === "CANVAS"){ try { b.getContext("2d").drawImage(a, 0, 0); } catch (err) {} }
    else if (a.tagName === "IFRAME"){
      const stub = document.createElement("div");
      stub.className = b.className;
      stub.style.cssText = b.style.cssText;
      b.replaceWith(stub);
    } else if (a.tagName === "VIDEO" || a.tagName === "AUDIO"){
      b.removeAttribute("autoplay");
      b.preload = "none";
      b.muted = true;
    }
  }
  return { copy, settle(){ for (const [n, top, left] of scrolls){ n.scrollTop = top; n.scrollLeft = left; } } };
}

// ---- the page turn -----------------------------------------------------------------------
// the answer to what stands in the sent panel lands on the card on show, and the
// card turns to a new page in one motion. what the reader was looking at, the
// answer they were on and the sent panel under it, glides up, eased on the
// card's gentle curve, and the new answer rides up with it, already in place
// under the sent messages: the sent panel is carried up to where the panel of
// answered messages stands at the head of a card, which is what it now is, since
// the board hands those same messages to the new answer, and the answer arrives
// under it as it goes. nothing is faded in after the glide; the answer is there
// the whole way up.
//
// the glide moves pictures and not the card. the page the reader was on is
// copied into a sheet laid over the card's column (the answer as it stood, at
// its scroll and with its fades, and the sent panel on its seat), the card under
// the sheet is drawn as the new page at once, and the new page is copied into
// the sheet too, under the old, one glide's length further down, so its panel
// stands exactly behind the old sent panel and its answer just under it. then
// only the sheet's content moves, on one transform, so no frame of the glide lays
// anything out or draws anything again. it goes up by exactly the distance from
// where the sent panel stood to where the new page's own panel stands, so when
// the sheet is taken away the new page under it is on the same pixels as its
// copy. the large card pictures its answer's scroller and the sent panel's
// seat; the small card, which keeps its panel, its answer and its sent panel as
// three pieces of one column, pictures the three.
//
// the reader is never moved while busy with the card. a new answer is held
// back, the page left exactly as it was, while the reader is reading (the answer
// was scrolled in the last three seconds, words in it are picked out, or an older
// page of its history is on show) or typing (a key went into the row in the last
// two seconds), and the card looks again every half second; the page turns
// once the card has been left still. a card that is not on show has nothing to
// turn and simply shows the new page, and so does a card whose reader asked for
// no motion. a new answer with no sent panel standing has nothing to glide and
// is printed in place instead (printReply). a progress note is not an answer and
// turns nothing
const TURN_GLIDE_MS = 560;    // the sheet's --turn-glide
const PRINT_MS = 780;         // the sheet's print: the last blocks start at 400ms and take 380
const READ_QUIET_MS = 3000;   // this long after the reader last scrolled the answer
const TYPE_QUIET_MS = 2000;   // this long after the last key into the row
const HOLD_LOOK_MS = 500;     // how often a held card looks again
const TURN_HELD = "held";

// the reader's own scrolling of the answer, which is what says they are reading
// it. the page's own moves of the scroll, a history step or a turn, are marked
// quiet as they are made, so they are not taken for the reader's
function watchReading(el){
  (el.replyview || el.reply).addEventListener("scroll", () => {
    if (Date.now() - (el.quietScroll || 0) > 200) el.readAt = Date.now();
  }, { passive: true });
}
function scrollCardTop(el){
  el.quietScroll = Date.now();
  (el.replyview || el.reply).scrollTop = 0;
}
function cardLaidOut(el){
  return !!(el.replyview || el.reply).getBoundingClientRect().height;
}
// a new answer swapped in with no page turn opens at its head: now if the card is laid out, else when it is next shown
function headOnSwap(el, b){
  if (cardOnShow(el) && b.replyKind !== "agent") return;
  if (cardLaidOut(el)) scrollCardTop(el);
  else el.headDue = true;
}
// a card hidden with display:none is handed back the scroll it was left at when it is shown again
function openAtHead(el){
  if (!el.headDue || !cardLaidOut(el)) return;
  el.headDue = false;
  scrollCardTop(el);
}
// and a key into a row, which is what says the reader is typing. each page calls
// it from its rows' input: the card's own bar and the phone's row. the
// formatter also says input when it puts its editor on or takes it off, to
// every card on load, and that is nobody typing, so only a row holding the
// caret counts, the way readOnCompose counts it
function noteTyping(ta){
  if (typeof ComposeFormat === "object" && ComposeFormat && ComposeFormat.focused(ta)) ta.typedAt = Date.now();
}

// the typing hold: the board does not hand a card to an agent while the reader is
// still typing on it, and keeps the one clock for that itself (TYPING_HOLD in
// server.py). the page only says "a change on this card" each time the reader makes
// one in the card's row: words typed, pasted, cut or deleted, or the caret or the
// selection moved, by a key that moves it or by a press in the row while it already
// has the caret. the caret coming into the row, what the row holds, and the page's
// own writes to it (a send emptying it, a draft put back, the editor coming on) say
// nothing. a report is never waited for, and one that fails is let go
const CARET_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);
function reportTyping(id){
  fetch("/typing?box=" + encodeURIComponent(id), { method: "POST" }).catch(() => {});
}
function watchTyping(ta, id){
  ta.addEventListener("input", e => { if (ComposeFormat.readerInput(e)) reportTyping(id); });
  // control with them is the board's own chords (another card, the answer, the
  // title), which move no caret
  ta.addEventListener("keydown", e => {
    if (e.isTrusted && CARET_KEYS.has(e.key) && !e.ctrlKey && ComposeFormat.focused(ta)) reportTyping(id);
  });
  // asked before the press lands, so the press that brings the caret in is focus
  ta.addEventListener("pointerdown", e => {
    if (e.isTrusted && ComposeFormat.focused(ta)) reportTyping(id);
  });
}

function stillMotion(){
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// the card on show: the one its page shows, whether chosen or only browsed to
// (a large card wears sel; the small cards show one and set the rest off), laid
// out, and not hidden under something the page lays over its whole board, the
// way the desktop's home page hides the stage
function cardOnShow(el){
  const view = el.replyview || el.reply;
  if (!view || el.box.classList.contains("off")) return false;
  if (el.replyview && !el.box.classList.contains("sel")) return false;
  if (!view.getBoundingClientRect().height) return false;
  return getComputedStyle(el.box).visibility !== "hidden";
}

// whether the reader is busy with the card on show
function turnHolding(el, id){
  if (!cardOnShow(el)) return false;
  if (hist && hist.id === id) return true;
  const now = Date.now();
  if (now - (el.readAt || 0) < READ_QUIET_MS) return true;
  if (el.ta && now - (el.ta.typedAt || 0) < TYPE_QUIET_MS) return true;
  if (typeof boxHasSelection === "function" && boxHasSelection(el.replyview || el.reply)) return true;
  // and the reader's caret standing in the answer (replyCaret), as a selection there does
  if (el.reply && typeof document === "object" && document.activeElement === el.reply) return true;
  // and a sent bubble part way through its own run, its flight or a merge is let finish it
  if (el.sentMerge) return true;
  if (sentPanels(el).some(one => one.classList.contains("motion") || one.classList.contains("sentflight"))) return true;
  return false;
}

// a held card looks again on its own clock, since a page that reads the board by
// its revision is handed nothing new to draw while the board stands still. once
// the reader has let the card be, the page draws its cards again and the turn runs
function turnHold(el, id){
  if (el.turnHeld) return;
  const look = () => {
    if (turnHolding(el, id)){ el.turnHeld = setTimeout(look, HOLD_LOOK_MS); return; }
    el.turnHeld = null;
    if (turnAgain) turnAgain();
  };
  el.turnHeld = setTimeout(look, HOLD_LOOK_MS);
}

// called by the page's pass over a card whose answer has changed, before it
// draws anything of the new one. it answers TURN_HELD when the new answer is to
// wait, and the page then leaves the answer and both panels as they stand; a
// turn, which the page hands to turnGo once it has drawn the new page; or
// nothing, for the plain swap the card always had
function turnBegin(el, b){
  if (el.turning) turnEnd(el);   // a turn still going lands at once
  if (!b || b.replyKind !== "agent" || !cardOnShow(el)) return null;
  if (stillMotion()) return null;
  if (turnHolding(el, b.id)){ turnHold(el, b.id); return TURN_HELD; }
  if (el.turnHeld){ clearTimeout(el.turnHeld); el.turnHeld = null; }
  const turn = { mode: "print" };
  if (el.sent && el.sentwrap && el.sentwrap.getBoundingClientRect().height) turnSheet(el, turn);
  // the new page opens at its head
  scrollCardTop(el);
  return turn;
}

// the pieces of a card's column a turn pictures: where the sheet goes, what the
// page the reader was on is made of, and what the new page is made of
function turnParts(el){
  if (el.replyview)
    return { region: el.replyview.parentElement, before: [el.replyview, el.sentwrap], after: [el.replyview] };
  return { region: el.box, before: [el.answwrap, el.reply, el.sentwrap], after: [el.answwrap, el.reply] };
}

// one still picture of one piece, laid in the sheet where the piece stands, shift
// further down. the answer's scroller keeps the depth its foot is cut to, and a
// picture never starts arriving or printing again
function turnPicture(el, node, turn, shift){
  const r = node.getBoundingClientRect();
  const copy = node.cloneNode(true);
  copy.style.position = "absolute";
  copy.style.top = (r.top + shift - turn.top) + "px";
  copy.style.left = (r.left - turn.left) + "px";
  copy.style.width = r.width + "px";
  copy.style.height = r.height + "px";
  copy.style.margin = "0";
  if (node === el.replyview)
    copy.style.setProperty("--boxband", (typeof boxBand === "function" ? boxBand(node, el.pendwrap) : 0) + "px");
  for (const one of [copy, ...copy.querySelectorAll(".arrive, .printing, .markin, .markout")])
    one.classList.remove("arrive", "printing", "markin", "markout");
  return copy;
}

// the still picture of the page the reader was on, over the card's column: from
// the head of the card's body on a large card, where a fade in the white over
// the answer takes what leaves, and from the first piece down on a small one,
// to the foot of the sent panel's seat either way
function turnSheet(el, turn){
  const parts = turnParts(el);
  // a sent bubble caught open, or part way through a run, is cut to its preview
  // where it stands, since what glides up is what stands at the head of the
  // new page, and a merge still going lands
  sentMergeStop(el);
  for (const sent of sentPanels(el)){
    if (!sent.classList.contains("open") && !sent.classList.contains("motion")) continue;
    sent.answRun = (sent.answRun || 0) + 1;
    settleAnswered(sent);
    sent.querySelector(".answclip").scrollTop = 0;
    sent.classList.remove("open");
    fitAnswered(sent);
  }
  const at = parts.region.getBoundingClientRect(), sr = el.sentwrap.getBoundingClientRect();
  const shown = parts.before.filter(node => node && node.getBoundingClientRect().height);
  const top = el.replyview ? at.top : Math.min(...shown.map(node => node.getBoundingClientRect().top));
  Object.assign(turn, { mode: "glide", top, left: at.left, from: sr.top });
  const sheet = h("div", "turnsheet");
  sheet.setAttribute("aria-hidden", "true");
  sheet.style.top = (top - at.top) + "px";
  sheet.style.height = (sr.bottom - top) + "px";
  const page = h("div", "turnpage");
  const pictures = shown.map(node => [node, turnPicture(el, node, turn, 0)]);
  page.append(...pictures.map(([, copy]) => copy));
  sheet.appendChild(page);
  parts.region.appendChild(sheet);
  // each picture of a scroller stands at the scroll the reader left it at
  for (const [node, copy] of pictures) if (node.scrollTop) copy.scrollTop = node.scrollTop;
  Object.assign(turn, { sheet, page, region: parts.region });
  el.turning = turn;
  // a sheet never outlives its glide, whatever becomes of the pass that laid it
  turn.timer = setTimeout(() => { if (el.turning === turn) turnEnd(el); }, TURN_GLIDE_MS + 80);
}

// called once the page has drawn the new page under the sheet: the glide, which
// brings the new answer up with it, or the print alone where nothing glides
function turnGo(el, turn){
  if (!turn || turn === TURN_HELD) return;
  if (turn.mode !== "glide"){ printReply(el); return; }
  // where the new page's own panel stands: the panel the sent messages have
  // just become. a new page with no panel at its head has nowhere to glide to,
  // and is shown and printed as it stands
  const dest = el.answ && el.answwrap ? el.answwrap.getBoundingClientRect().top : null;
  const lift = dest == null ? 0 : turn.from - dest;
  if (!(lift > 1)){ turnEnd(el); printReply(el); return; }
  // the new page, pictured a glide's length further down and under the picture
  // of the old one, so its panel waits behind the old sent panel and its answer
  // stands just under it, and all of it comes up on the one transform
  const fresh = turnParts(el).after.filter(node => node && node.getBoundingClientRect().height)
    .map(node => turnPicture(el, node, turn, lift));
  turn.page.prepend(...fresh);
  void turn.page.offsetWidth;   // the sheet stands as the reader left it before it moves
  turn.page.classList.add("gliding");
  turn.page.style.transform = "translate3d(0, " + (-lift) + "px, 0)";
  // the sent bubbles are on their way to being the panel over the answer, which
  // carries no word: their marks fade out on the way up, and a bubble still
  // faded takes its full grey and ink with it. the seat's picture also gives
  // way to the new page's panel behind it over the second half of the glide
  // (the sheet's turnhand), since the bubbles may share the messages out
  // differently from the one panel over the answer, so the swap when the sheet
  // goes is not one
  for (const rising of turn.page.querySelectorAll(".answered.sent")){
    fadeMark(rising);
    for (const one of [rising, ...rising.querySelectorAll(".undelivered")]) one.classList.remove("undelivered");
  }
  clearTimeout(turn.timer);
  const done = e => {
    if (e && (e.target !== turn.page || e.propertyName !== "transform")) return;
    turn.page.removeEventListener("transitionend", done);
    if (el.turning === turn) turnEnd(el);
  };
  turn.page.addEventListener("transitionend", done);
  turn.timer = setTimeout(done, TURN_GLIDE_MS + 80);
}

// the glide has landed, or is cut short by a newer answer: the pictures go, and
// the new page they were copied from stands where they stood
function turnEnd(el){
  const turn = el.turning;
  if (!turn) return;
  el.turning = null;
  clearTimeout(turn.timer);
  if (turn.sheet) turn.sheet.remove();
}

// the print, for a new answer that has nothing to glide with: its blocks come in
// one after another from the top, each a fade with a small rise (the sheet's
// cardprint), fifty milliseconds apart and all of them under way by the ninth.
// only strength and a transform are drawn, so the answer's layout is final from
// the first frame and nothing under it moves
function printReply(el){
  const reply = el && el.reply;
  if (!reply) return;
  if (stillMotion()) return;
  reply.classList.remove("printing");
  void reply.offsetWidth;   // a print still going starts again from its first block
  reply.classList.add("printing");
  clearTimeout(el.printTimer);
  el.printTimer = setTimeout(() => reply.classList.remove("printing"), PRINT_MS + 60);
}

// ---- sending, parking, naming ---------------------------------------------------------
// writing to a done, docked or parked card takes it back to doing: the done flag is
// read before the send and flipped after the message is in, so a flip that
// fails can never eat it
function boxDone(id){
  const b = lastState && lastState.boxes.find(x => x.id === id);
  return !!(b && b.done);
}

// ---- the moon: the tap is the state, the board is the witness -----------------
// A tap on the moon changes the card on screen at once and the board is told
// after, because the board's answer can be a second or more away while the card
// being tapped is the card being looked at. What stands on screen until the
// board answers is this page's own held tap, kept card by card the way the tab
// bar's record and the read marks are kept here: the newest tap wins, a reading
// asked for before the board answered that tap may not repaint the card, and an
// answer to a tap that has since been reversed changes nothing.
//
// Reversing is what the second tap is for, not an accident of it: a tap while
// the first request is still out flips the card back at once and the board is
// told the latest requested value. The chip is never disabled, every tap is
// drawn immediately, and pending taps keep the latest value to send next.
//
// One request per card at a time. A newer tap while one is out is drawn at once
// and sent the moment that one answers, because two requests for one card carry
// two absolute values and can land in the other order, and then the board would
// keep the value that was undone.
//
// That is not enough on its own, and this is the part worth stating plainly:
// GIVING UP ON AN ANSWER DOES NOT STOP THE REQUEST. A deadline here abandons
// the answer; the bytes are already travelling and the board will still act on
// them. So a snooze that timed out can arrive after the unsnooze that replaced
// it and overwrite it, and no amount of care on this side can prevent that.
// Every attempt therefore names this page's own command stream and its place in
// it, and the board refuses a place it has already passed. Ordering is the
// board's to enforce because only the board sees the arrivals.
//
// Nothing here says the board has it until the board has said so, and a 2xx
// alone is not the board saying so: an answer that cannot be read, an empty
// one, or one that never says it did the thing leaves this page not knowing,
// which is held as not knowing rather than called a success. A tap still
// travelling wears flagwait, a tap the board refused goes back to the board's
// word with the reason left on the card, and a tap nobody can confirm is held,
// plainly unconfirmed, until a reading settles it or the window ends it.
//
// And a tap is never quietly dropped for looking unnecessary. A tap whose value
// happens to match the last reading is still sent, because a reading is not a
// promise about what an older command still in transit will do when it lands.
// Until the board has answered the value on screen, the hold belongs to the tap
// and no reading may retire it.
const FLAG_KINDS = {
  dock: { kind: "dock", field: "docked", cls: "docked", word: "dock" },
  park: { kind: "park", field: "parked", cls: "parked", word: "snooze" },
  done: { kind: "done", field: "done", cls: "done", word: "done" },
};
const FLAG_DEADLINE_MS = 8000;   // the phone's own reading carries the same one
const FLAG_HOLD_MS = 20000;      // the longest an unanswered tap may stand on screen
const flagHolds = {};            // id + "/" + kind -> the tap this page is standing behind
let flagTaps = 0;                // every attempt is numbered: its place in this page's stream
let flagStream = "";             // this page load's own name for that stream

function flagKey(id, kind){ return id + "/" + kind; }
function flagSpec(kind){ return FLAG_KINDS[kind] || FLAG_KINDS.park; }
// what a note calls the tap it is about, which is the direction it asked for.
// Neither "tap" nor "click": one line serves the phone and the desktop
function flagWord(spec, want){
  return spec.kind === "park" ? (want ? "snooze" : "unsnooze") : want ? spec.word : "un" + spec.word;
}
// why the board says it kept what it had, in the words of the tap it is about
function flagStaleWord(spec, sent, why){
  const word = flagWord(spec, sent);
  if (why === "message") return spec.kind === "park"
    ? "snooze skipped: a new message arrived" : word + " skipped: a new message arrived";
  if (why === "superseded") return word + " skipped: a newer tap replaced it";
  return word + " skipped: the card changed";
}
function flagDeadline(){
  try { return AbortSignal.timeout(FLAG_DEADLINE_MS); } catch (err) { return undefined; }
}
// this page load's name for its own command stream, made on the first tap, so
// nothing in this file still runs on load. Letters and digits only, short, and
// this page load's alone: it names who is asking, never what is being asked
// for. A reload is a new stream, and a command left over from before a reload
// is therefore not ordered against the new page's commands
function flagStreamOf(){
  if (!flagStream) flagStream = "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  return flagStream;
}

// what the card is showing this moment: this page's held tap where there is
// one, the class the last reading painted otherwise. The tap is read from here
// rather than from the class alone, so two taps inside one request's time ask
// for two different things instead of the same thing twice
function flagShown(id, kind){
  const hold = flagHolds[flagKey(id, kind)];
  if (hold) return hold.want;
  const spec = flagSpec(kind);
  const el = els[id];
  if (el && el.box) return el.box.classList.contains(spec.cls);
  const b = lastState && lastState.boxes.find(x => x.id === id);
  return !!(b && b[spec.field]);
}

function toggleFlag(id, kind){ return setFlag(id, kind, !flagShown(id, kind)); }

// A destination is named, unlike the moon's reversible tap. Read the held value
// so a second request during an unanswered one is judged against what the card
// already shows, then use the same ordered flag requests as a tap.
function setCardDestination(id, destination){
  if (destination === "docked"){
    if (!flagShown(id, "dock")) return setFlag(id, "dock", true);
  } else if (destination === "deferred"){
    if (!flagShown(id, "park")) return setFlag(id, "park", true);
  } else if (destination === "doing"){
    const docked = flagShown(id, "dock"), parked = flagShown(id, "park"), done = flagShown(id, "done");
    if (docked) setFlag(id, "dock", false);
    if (parked) setFlag(id, "park", false);
    if (done) return setFlag(id, "done", false);
  }
}

// the Doing list as both pages draw it, top to bottom, by card id
function doingOrder(state){ return state ? viewPoolFor(state, "todo").map(b => b.id) : []; }

// Capture the section before a move changes its flags or a close waits on HTTP.
function cardDeparture(state, id){
  const b = state?.boxes.find(x => x.id === id);
  const section = b ? cardSection(b) : "todo";
  return { section, order: state ? viewPoolFor(state, section).map(x => x.id) : [] };
}

// where the screen goes when a card leaves Doing: the card below it, else the
// one above it, else nothing. order is the list from before the card left; a
// card that was not in it gets the top card; the standing boxes are skipped
function doingNeighbour(id, order){
  const at = order.indexOf(id);
  const open = x => x !== id && !isStandingBox(x);
  if (at < 0) return order.find(open) ?? null;
  return order.slice(at + 1).find(open) ?? order.slice(0, at).reverse().find(open) ?? null;
}

// Keep the next/previous neighbour in the departed section first. When it is
// empty, walk the following sections in Doing, Docked, Deferred, Done order,
// wrapping only after Done. The moved card and standing boxes are never picked.
function selectNextCard(id, order, section = "todo"){
  if (selectedId !== id) return;
  const live = new Set(lastState ? viewPoolFor(lastState, section).map(b => b.id) : []);
  let next = doingNeighbour(id, order.filter(x => x === id || live.has(x)));
  let view = section;
  if (!next && lastState){
    const at = TICKET_VIEWS.indexOf(section);
    for (let n = 1; n < TICKET_VIEWS.length; n++){
      view = TICKET_VIEWS[(at + n) % TICKET_VIEWS.length];
      next = viewPoolFor(lastState, view).find(b => b.id !== id && !isStandingBox(b.id))?.id;
      if (next) break;
    }
  }
  if (next){ setTicketViewOf(activeOwner, view); select(next, { hop: true }); }
  else deselect();
}

// ---- the four section chips ---------------------------------------------------
// every card carries a chip for each section, left to right in the tabs' own
// order: the sun for doing, the cloud for docked, the moon for deferred, the cross for done. the chip
// that names the section the card already stands in is faded and switched off,
// since pressing it could only ask for what is already true. it is marked with
// aria-disabled rather than the disabled property so it keeps its place in the
// keyboard's path through the card, and each chip's own click reads the mark
// and does nothing while it stands
const SECTION_CHIPS = { todo: "sun", docked: "dock", deferred: "arc", done: "x" };
// a large hollow ring with eight short marks around it, drawn on the moon's 24
// unit box at the moon's 9px. the ring and the marks share one stroke, set once
// on the svg, so they are one weight by construction. the ring is the main
// shape: radius 4.35 under the 2.4 stroke leaves a hole 6.3 units across, near
// 2.4px at this size, and puts its outer edge at 5.55. the marks start at 8.55
// so their round inner ends keep 1.8 units of air clear of the ring, and end at
// 10.5 so their round outer ends stay inside the box
const SUN_ICON = '<svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor" ' +
  'stroke-width="2.4" stroke-linecap="round" aria-hidden="true">' +
  '<circle cx="12" cy="12" r="4.35"></circle>' +
  '<path d="M12 1.5L12 3.45M12 20.55L12 22.5M1.5 12L3.45 12M20.55 12L22.5 12' +
  'M4.58 4.58L5.95 5.95M18.05 18.05L19.42 19.42M4.58 19.42L5.95 18.05M18.05 5.95L19.42 4.58"></path></svg>';
// The sun partly covered by the cloud, with no extra fill colour, drawn in the
// sun's own way: stroke 2.4 and round caps, rays 1.95 long on the same 45 degree
// spokes, one ray wherever a spoke clears the cloud (five of them here). the ring
// (radius 3.8, centre 10.95 11.38) is one arc that stops on the cloud's own
// centre line, so its round ends lie inside the cloud's stroke and no line of
// the sun reaches into the cloud. the cloud is the old outline at 0.8 so the
// sun has the room to show its ring and the fifth ray; the whole is centred on
// the 24 box, as the sun is. the marks keep 1.2 of air from the ring, where the
// full size sun keeps 1.8, since a sun with 1.8 would not fit the box beside a cloud
const DOCK_ICON = '<svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor" ' +
  'stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M12.89 14.64A3.8 3.8 0 1 1 14.18 13.37"></path>' +
  '<path d="M5.72 16.61L4.34 17.99M3.55 11.38L1.6 11.38M5.72 6.14L4.34 4.76M10.95 3.97L10.95 2.03M16.19 6.14L17.57 4.76"></path>' +
  '<path d="M11.694 21.975H19.694A2.8 2.8 0 0 0 20.254 16.455A4 4 0 0 0 12.574 15.255A3.44 3.44 0 0 0 11.694 21.975Z"></path></svg>';
function chipOff(chip){ return !!chip && chip.getAttribute("aria-disabled") === "true"; }

// the sun, built the same on every surface; each page seats it and dresses it
function sunChip(cls, id){
  const sun = h("button", cls);
  sun.type = "button";
  sun.title = "move to doing\n" + SECTION_KEY_HINTS.doing;
  sun.setAttribute("aria-label", "move to doing");
  sun.innerHTML = SUN_ICON;
  sun.addEventListener("click", e => { e.stopPropagation(); if (!chipOff(sun)) wakeCard(id); });
  return sun;
}

function dockChip(cls, id){
  const dock = h("button", cls);
  dock.type = "button";
  dock.title = "move to docked\n" + SECTION_KEY_HINTS.docked;
  dock.setAttribute("aria-label", "move to docked");
  dock.innerHTML = DOCK_ICON;
  dock.addEventListener("click", e => { e.stopPropagation(); if (!chipOff(dock)) setCardDestination(id, "docked"); });
  return dock;
}

// el.sun, el.dock, el.arc and el.x are the card's four chips under whatever classes the
// surface gives them. only a chip whose state changes is written, so a poll that
// moves nothing leaves a hover where it is
function paintSectionChips(el, b){
  const here = SECTION_CHIPS[cardSection(b)];
  for (const name of ["sun", "dock", "arc", "x"]){
    const chip = el && el[name];
    if (!chip || chipOff(chip) === (name === here)) continue;
    if (name === here) chip.setAttribute("aria-disabled", "true");
    else chip.removeAttribute("aria-disabled");
  }
}

// the sun's own move: whatever holds the card out of doing is lifted, through
// the same ordered flag requests a tap on the moon makes. a card the board
// holds both parked and done shows as done, so its face carries no parked class
// and setCardDestination's read of it sees none; the reading's own park flag is asked as
// well here, or the sun would lift the done and leave the card in deferred
function wakeCard(id){
  const b = typeof lastState === "undefined" ? null : lastState?.boxes.find(x => x.id === id);
  if (b && b.parked && !flagHolds[flagKey(id, "park")] && !flagShown(id, "park")) setFlag(id, "park", false);
  if (b && b.docked && !flagHolds[flagKey(id, "dock")] && !flagShown(id, "dock")) setFlag(id, "dock", false);
  return setCardDestination(id, "doing");
}

// a section key asks what that section's chip on the card's face would ask,
// and nothing while that chip stands faded because the card is already there.
// deferred only ever parks, where the moon's tap could also unpark, and done
// is the page's own close, handed in, since each surface closes its own way.
// true means a move was asked for
const SECTION_KEY_CHIPS = { doing: "sun", docked: "dock", deferred: "arc", done: "x" };
function sectionKeyMove(id, section, el, close){
  const chip = el && el[SECTION_KEY_CHIPS[section]];
  if (!chip || chipOff(chip)) return false;
  if (section === "doing") wakeCard(id);
  else if (section === "docked" || section === "deferred") setCardDestination(id, section);
  else close(id);
  return true;
}

// one card's wanted state, true on screen at once and asked of the board after.
//
// The order of the steps below is load bearing. The intent is written down and
// sent BEFORE anything is redrawn, because redrawing runs the pass that
// reconciles holds, and a hold reconciled away in the middle of this function
// is an intent that is never sent at all. That is not hypothetical: a reversal
// whose value happens to agree with the last reading looks like nothing to do
// to that pass, exactly when it matters most, since the older command it is
// there to overtake may still be on its way to the board.
function setFlag(id, kind, want){
  const current = typeof lastState === "undefined" ? null : lastState?.boxes.find(b => b.id === id);
  const section = current && cardSection(current);
  const advance = (kind === "park" || kind === "dock") && want &&
    typeof selectedId !== "undefined" && selectedId === id &&
    typeof curView === "function" && curView() === section &&
    current && current.owner === activeOwner &&
    (section === "todo" || (kind === "park" && section === "docked"));
  const order = advance ? cardDeparture(lastState, id).order : null;
  // A destination replaces an earlier destination, including a request still
  // travelling. The shared stream lets the server reject its late arrival.
  if (want) for (const other of Object.keys(FLAG_KINDS)){
    if (other !== kind) dropFlag(flagKey(id, other));
  }
  const spec = flagSpec(kind);
  const key = flagKey(id, kind);
  const hold = flagHolds[key] || (flagHolds[key] = { id, kind, truth: null, boxRef: null, sending: 0 });
  hold.want = want;
  hold.owed = true;           // said on screen, not yet said to the board
  hold.until = Date.now() + FLAG_HOLD_MS;
  hold.basis = serverNow();   // the board's own clock at this tap, for the board to judge it by
  hold.settled = false;
  clearTimeout(hold.timer); hold.timer = null;
  flagNote(id, "");           // the last failure is answered by this tap
  paintFlag(id, spec, want, true);                                  // the card, in this same turn
  const going = hold.sending ? Promise.resolve() : sendFlag(key);   // the board, before any redraw
  flagRepaint();                                                    // the list, the tabs, the place
  if (advance) selectNextCard(id, order, section);
  return going;
}

// a hold with a command owed or a command out is nobody else's to retire: the
// board has not answered the value this page is holding, and an older command
// of this page's own may still be travelling towards it
function flagBusy(hold){ return !!hold.sending || !!hold.owed; }

async function sendFlag(key){
  const hold = flagHolds[key];
  if (!hold || hold.sending) return;
  const want = hold.want, tap = ++flagTaps;
  hold.sending = tap;
  hold.guard = Infinity;   // while this is out, no reading knows enough to repaint the card
  const url = "/" + hold.kind + "?box=" + encodeURIComponent(hold.id) + "&v=" + (want ? 1 : 0) +
    // this page's own command stream and this attempt's place in it. Abandoning
    // an answer does not recall a request, so an attempt this page has already
    // replaced can still arrive last; the board refuses a place it has passed
    "&sid=" + encodeURIComponent(flagStreamOf()) + "&seq=" + tap +
    // the moment of the tap, on the board's clock: a snooze that crossed a
    // message on the way is a snooze decided before that message existed
    (want && hold.basis ? "&after=" + encodeURIComponent(hold.basis.toFixed(3)) : "");
  let status = 0, body = null, lost = "";
  try {
    const r = await fetch(url, { method: "POST", signal: flagDeadline() });
    status = r.status;
    body = await r.json().catch(() => null);
  } catch (err){
    lost = err && err.name === "TimeoutError" ? "timeout" : "network";
  }
  flagAnswered(key, tap, want, status, body, lost);
}

// What an answer is worth, in one place. The four outcomes are kept apart on
// purpose, because they call for four different things: an acknowledgment, a
// refusal, a reason for keeping the old value, and not knowing.
function flagAnswered(key, tap, sent, status, body, lost){
  const hold = flagHolds[key];
  if (!hold || hold.sending !== tap) return;   // a newer tap owns this card; this answer is history
  hold.sending = 0;
  const spec = flagSpec(hold.kind);
  const ok = status >= 200 && status < 300;
  // only an object can be read as an answer. A body that is null (unreadable
  // JSON), a string, or anything else is no answer at all, whatever the status
  const answer = body && typeof body === "object" ? body : null;
  const said = answer && typeof answer[spec.field] === "boolean" ? answer[spec.field] : null;
  const why = answer && answer.ok === false && typeof answer.stale === "string" ? answer.stale : "";
  if (hold.want !== sent){ sendFlag(key); return; }   // the card was tapped again; that is what goes
  // from here the value on screen is the value the board has been told, so the
  // hold stops being this page's to protect and becomes the board's to answer
  hold.owed = false;
  if (lost){ flagUnsure(key, spec); return; }         // the request may well have landed
  if (!ok){
    // a definite refusal: the board answered and did not do it. The card goes
    // back to the board's word with the reason in plain sight, and the chip is
    // live, so one more tap asks again for exactly the same thing
    flagTell(hold.id, spec, said,
      flagWord(spec, sent) + " failed (" + (status || "no answer") + "): try again");
    poll();
    return;
  }
  if (why === "superseded" && said != null && said === hold.want){
    // an attempt this page itself replaced, arriving after the one that
    // replaced it. The board is already on the value the card is showing, so
    // there is nothing to undo and nothing worth saying
    hold.guard = Date.now();
    hold.settled = true;
    paintFlag(hold.id, spec, hold.want, false);
    poll();
    return;
  }
  if (why){
    // the board kept what it had and said why: a message reached the card
    // first, or a newer tap of this page's own got there first. Nothing was
    // applied, and this is not a failure to retry
    flagTell(hold.id, spec, said, flagStaleWord(spec, sent, why));
    poll();
    return;
  }
  if (answer && answer.ok === false){
    // an explicit no with no reason given. Nothing was applied, so the card
    // goes back to the board's word and the chip asks again
    flagTell(hold.id, spec, said,
      flagWord(spec, sent) + " refused by the board: try again");
    poll();
    return;
  }
  if (!answer || answer.ok !== true){
    // 2xx and nothing else. An answer that cannot be read, an empty one, or one
    // that never says it did the thing is not an acknowledgment, and calling it
    // one would leave a snooze on screen that the board may never have made.
    // The request may still have landed, so nothing is taken back either
    flagUnsure(key, spec);
    return;
  }
  // ok:true, which is the acknowledgment, and all an older board ever sent. The
  // moment it answered is the guard: a reading asked for before now knows
  // nothing of this card and may not repaint it
  hold.guard = Date.now();
  hold.settled = true;
  paintFlag(hold.id, spec, hold.want, false);
  poll();
}

// the board has not said yes and has not said no. Nothing is taken back, since
// the request may have landed, and nothing is called confirmed, since it may
// not have: the card keeps the tap, keeps saying it is unconfirmed, and the
// readings that follow settle it. If none ever does, the window ends it with a
// plain word rather than leaving a snooze standing on an unchanged board
function flagUnsure(key, spec){
  const hold = flagHolds[key];
  if (!hold) return;
  hold.guard = Date.now();
  hold.settled = false;
  paintFlag(hold.id, spec, hold.want, true);
  flagWindow(key);
  poll();
}

// an answer that never came cannot hold a card for ever
function flagWindow(key){
  const hold = flagHolds[key];
  if (!hold) return;
  clearTimeout(hold.timer);
  hold.timer = setTimeout(() => flagExpire(key), Math.max(0, hold.until - Date.now()));
}
function flagExpire(key){
  const hold = flagHolds[key];
  if (!hold || flagBusy(hold) || hold.settled) return;
  const spec = flagSpec(hold.kind);
  flagTell(hold.id, spec, null, flagWord(spec, hold.want) + " not confirmed: try again");
}

// the board's word wins and the reason stays on the card: the hold ends, the
// card goes back to what the board last said (or to what this very answer
// said, which is newer), and the note stands until the next tap. No reading
// clears it, which is the whole of its worth
function flagTell(id, spec, said, text){
  const key = flagKey(id, spec.kind);
  const hold = flagHolds[key];
  if (hold && hold.truth && said != null && hold.truth[spec.field] !== said){
    hold.truth[spec.field] = said;
    hold.truth.state = null;   // the flag this answer named is newer than the state beside it
  }
  // the board's word for this card: the answer's own, else the last reading's,
  // else the state the card stood in before the tap that has just been refused
  const back = said != null ? said
             : hold && hold.truth ? !!hold.truth[spec.field]
             : hold ? !hold.want : flagShown(id, spec.kind);
  dropFlag(key);
  paintFlag(id, spec, back, false);
  flagNote(id, text);
  flagRepaint();
}

// the card's own note line, under whichever of the two names the page gives it.
// A note written here is this page's record of a tap the board refused or never
// answered, so the pass over the cards is told to leave it where it is.
//
// The order of the two names matters and is not a preference. metaNote is the
// note element itself, which is the node the desktop's own pass reads and
// writes; meta is the phone's note element under its own name, but on the
// desktop that name belongs to the box the note element lives in. Writing text
// to a box throws away the children it has, so choosing it first would delete
// the very note element the page holds a reference to: the page would keep a
// detached node, its guard would sit on the wrong node, and nothing written
// through that reference afterwards would ever be seen again. The note element
// is chosen where the page has one, its wrapper is left alone, and the text,
// the guard and the clearing all land on that one connected node.
function flagNote(id, text){
  const el = els[id];
  const note = el && (el.metaNote || el.meta);
  if (!note) return;
  note.textContent = text || "";
  if (text) note.dataset.flagnote = "1";
  else delete note.dataset.flagnote;
}

function paintFlag(id, spec, want, waiting){
  const el = els[id];
  if (!el || !el.box) return;
  el.box.classList.remove("peek");   // the desktop's peek; nothing on the phone wears it
  el.box.classList.toggle(spec.cls, want);
  if (want) for (const other of Object.values(FLAG_KINDS)){
    if (other !== spec) el.box.classList.remove(other.cls);
  }
  el.box.classList.toggle("flagwait", !!waiting);
}

// the hold is over: what the board said goes back into the card it was taken
// from, so the pass that draws next draws the board and not this page's tap
function dropFlag(key){
  const hold = flagHolds[key];
  if (!hold) return;
  clearTimeout(hold.timer);
  if (hold.boxRef && hold.truth){
    hold.boxRef.docked = hold.truth.docked;
    hold.boxRef.parked = hold.truth.parked;
    hold.boxRef.done = hold.truth.done;
    hold.boxRef.state = hold.truth.state;
  }
  delete flagHolds[key];
  const el = els[hold.id];
  if (el && el.box) el.box.classList.remove("flagwait");
}

// the pass a reading goes through before anything is drawn from it. A card this
// page is holding a tap for is shown the way it was left, with the reading's own
// word for it kept aside to go back to; a reading new enough to judge the tap
// either agrees with it, which ends the hold, or carries something newer, which
// ends it too. Every colour, list, sort and tab reads the boxes, so holding the
// tap here is the whole board following the tap rather than the chip alone
let flagDrawing = false;   // a pass is running; a repaint asked for inside it is that pass's own
function holdFlags(state){
  if (!state || !Array.isArray(state.boxes)) return state;
  const asked = state.fetchedAt || 0;
  flagDrawing = true;
  try { holdFlagsPass(state, asked); } finally { flagDrawing = false; }
  return state;
}
function holdFlagsPass(state, asked){
  for (const key of Object.keys(flagHolds)){
    const hold = flagHolds[key];
    if (!hold) continue;   // an end reached inside this same pass
    const spec = flagSpec(hold.kind);
    const b = state.boxes.find(x => x.id === hold.id);
    if (!b){ dropFlag(key); continue; }   // the card is gone and so is the tap
    // a box this page has not already written into is the reading's own word
    // for the card. A pass over cards this page has already held (a redraw, or
    // the phone's unchanged answer, which moves the clock and brings no cards)
    // carries no word about this card at all, and a hold may never be judged
    // by a word its reading did not bring
    const fresh = hold.boxRef !== b;
    if (fresh) hold.truth = { docked: b.docked, parked: b.parked, done: b.done, state: b.state };
    if (fresh && !flagBusy(hold) && asked >= hold.guard){
      if (hold.truth[spec.field] === hold.want){ dropFlag(key); continue; }   // the board agrees
      // the board had this tap and something newer has changed the card since:
      // a message sent to it, a close, another device. That is the board's to
      // say, and a held tap must not put it back
      if (hold.settled){ dropFlag(key); continue; }
      if (Date.now() >= hold.until){ flagExpire(key); continue; }
    }
    b[spec.field] = hold.want;
    if (hold.want) for (const other of Object.values(FLAG_KINDS)){
      if (other !== spec) b[other.field] = false;
    }
    // Docked keeps the server's live state, including note/deferred/rest which
    // the older flag-only derivation cannot reconstruct. Peel only a section
    // mask; painting an unmasked card must not invent a different work state.
    const live = hold.truth && !["done", "parked"].includes(hold.truth.state) ? hold.truth.state : null;
    b.state = cardState({ ...b, state: !b.done && !b.parked ? live : null });
    hold.boxRef = b;
  }
}

// Closing participates in the same ordering as docking and deferring.
function closeCardUrl(id){
  for (const kind of Object.keys(FLAG_KINDS)) dropFlag(flagKey(id, kind));
  return "/close?box=" + encodeURIComponent(id) + "&sid=" + encodeURIComponent(flagStreamOf()) + "&seq=" + (++flagTaps);
}

// what the page draws from, drawn again now. The tapped card has already
// changed; this is the list, the tabs and the card's place following it
function flagRepaint(){
  if (flagDrawing) return;   // the pass that is running draws it
  if (typeof apply !== "function") return;
  const state = typeof lastState === "undefined" ? null : lastState;
  if (!state) return;
  try { apply(holdFlags(state)); }
  catch (err){ if (typeof reportProblem === "function") reportProblem("render", err); }
}

// the board's clock, now, as this page can best tell it: the last reading
// carried the board's own time and the moment it was asked for. It is the
// board's clock and not this device's, which is what makes it safe to compare
// against times the board itself wrote. Zero when no reading has carried one,
// and a request with no basis simply sends none and is judged as it always was
function serverNow(){
  const state = typeof lastState === "undefined" ? null : lastState;
  if (!state || typeof state.now !== "number" || !state.fetchedAt) return 0;
  return state.now + (Date.now() - state.fetchedAt) / 1000;
}

// ---- the card's title -----------------------------------------------------------
// the big title on a card keeps to two lines. one line, or two at the sheet's own
// size, stand exactly as the sheet draws them. a title that would run on to a third
// line takes the largest size at which it sits on two, measured and not stepped,
// down to TITLE_MIN at the smallest, and grows back as words go. typing stops at two
// full lines at TITLE_MIN, on the Mac's card or the phone's, whichever fills first,
// the same on both pages (TITLE_CARDS): a key that would start a third adds nothing,
// and a paste puts in the words that fit. a title longer than that (typed before the
// limit, set by an agent, or the name a first message gave) takes TITLE_MIN and is
// cut at the foot of its second line, with nothing written after it, and the title
// the board stores is left as it is. renamed, it keeps that same two line box at the
// same size: the words past the cut come into it as the caret goes to them, the box
// scrolling inside itself a whole line at a time, and words taken out let the rest
// come up. at rest it shows its first two lines again
const TITLE_LINES = 2, TITLE_MIN = 20, TITLE_STEP = 0.05;

// the size a title takes: the largest from base down to min at which linesAt (the
// words laid out at a size, their lines counted) gives no more than two, found to
// a twentieth of a pixel. over: two lines at min do not hold them
function titleFitSize(linesAt, base, min = TITLE_MIN){
  if (linesAt(base) <= TITLE_LINES) return { size: base, over: false };
  if (!(base > min) || linesAt(min) > TITLE_LINES) return { size: Math.min(base, min), over: true };
  let fits = min, not = base;
  while (not - fits > TITLE_STEP){
    const mid = (fits + not) / 2;
    if (linesAt(mid) <= TITLE_LINES) fits = mid; else not = mid;
  }
  return { size: fits, over: false };
}

// how much of `text` goes into a title: all of it when the title still fits with
// it, or when it is no longer than what it replaces (a title already past two lines
// may be cut down but not added to); otherwise the longest start of it that fits,
// ended at the end of a whole word when an earlier word ends inside it. fits(part)
// answers whether the title fits with part put in; taken is the length part replaces
function titleRoom(fits, text, taken){
  if (text.length <= taken || fits(text)) return text;
  if (!fits("")) return "";
  let lo = 0, hi = text.length;
  while (hi - lo > 1){
    const mid = (lo + hi) >> 1;
    if (fits(text.slice(0, mid))) lo = mid; else hi = mid;
  }
  if (/\S/.test(text[lo]) && /\S/.test(text[lo - 1] || "")){
    const word = text.slice(0, lo).search(/\s\S*$/);
    if (word > 0) lo = word;
  }
  while (lo > 0 && /\s/.test(text[lo - 1])) lo--;
  return text.slice(0, lo);
}

// where each line of a title's words starts as laid out now: the boxes a Range
// hands back over them, one run of boxes to a line, read by where each line starts
function titleRowTops(t){
  const half = parseFloat(getComputedStyle(t).lineHeight) / 2 || 0;
  const rg = document.createRange();
  rg.selectNodeContents(t);
  const tops = [];
  for (const q of [...rg.getClientRects()].sort((a, b) => a.top - b.top))
    if (q.height > 0 && (!tops.length || q.top > tops[tops.length - 1] + half)) tops.push(q.top);
  return tops;
}

// the lines a title's words take as laid out now
function titleLines(t){
  return titleRowTops(t).length;
}

// how far one line of a title stands below the one before, as laid out. an engine
// can round a line to its own units (WebKit lays a 25.38px line at 25px), and the
// cut and the scroll go by the lines as they stand, so no sliver of a third shows
function titlePitch(t, tops = titleRowTops(t)){
  return tops.length > 1 ? (tops[tops.length - 1] - tops[0]) / (tops.length - 1) : parseFloat(getComputedStyle(t).lineHeight);
}

// fits a card's title to its two lines (above), from the sheet's own size each
// time. a title not laid out, on a card not on show, keeps what it has and is
// fitted as its card shows (watchTitle). the cut stays on while the size is
// measured, since lines are counted off the words' own boxes, which a cut does not
// move, so a title being renamed keeps the lines it is scrolled to
function fitTitle(t){
  if (!t || !t.style || typeof t.style.removeProperty !== "function" ||
      typeof getComputedStyle !== "function" || !t.isConnected || !t.getClientRects().length) return;
  const s = t.style, top = t.scrollTop || 0;
  s.removeProperty("font-size");
  s.removeProperty("line-height");
  const cs = getComputedStyle(t), base = parseFloat(cs.fontSize), ratio = parseFloat(cs.lineHeight) / base;
  let fit = { size: base, over: false };
  if (base > 0 && ratio > 0 && titleLines(t) > TITLE_LINES){
    // the line keeps the sheet's own proportion to the letters at every size
    const at = size => {
      s.setProperty("font-size", size + "px");
      s.setProperty("line-height", size * ratio + "px");
      return titleLines(t);
    };
    fit = titleFitSize(at, base);
    at(fit.size);
  }
  if (!fit.over){ s.removeProperty("max-height"); s.removeProperty("overflow"); return; }
  s.setProperty("max-height", TITLE_LINES * titlePitch(t) + "px");
  s.setProperty("overflow", "hidden");
  t.scrollTop = t.isContentEditable ? top : 0;
}

// the line of a title the caret (the moving end of a selection) stands on, by the
// line starts tops, or -1 when it is not in the title or has no box
function titleCaretRow(t, tops){
  const sel = getSelection();
  if (!sel || !sel.rangeCount || !sel.focusNode || !t.contains(sel.focusNode)) return -1;
  const r = document.createRange();
  r.setStart(sel.focusNode, sel.focusOffset);
  const q = r.getClientRects()[0] || r.getBoundingClientRect();
  if (!q || !q.height) return -1;
  const mid = (q.top + q.bottom) / 2;
  let row = 0;
  for (let i = 1; i < tops.length; i++) if (mid >= tops[i]) row = i;
  return row;
}

// a cut title being renamed is scrolled by the browser to keep the caret in sight,
// which can stop part way through a line, or nudge a pixel past one (WebKit does,
// for a caret on the last line in view). it is set on the whole line nearest where
// the browser left it that still shows the caret's own line, so the box always
// shows two whole lines and moves only when the caret goes past them
function titleScrolled(t){
  if (!t.isContentEditable || !t.style.maxHeight) return;
  const tops = titleRowTops(t);
  if (tops.length <= TITLE_LINES) return;
  const line = titlePitch(t, tops), now = t.scrollTop;
  if (!(line > 0)) return;
  let first = Math.round(now / line);
  const caret = titleCaretRow(t, tops);
  if (caret >= 0) first = Math.min(caret, Math.max(caret - TITLE_LINES + 1, first));
  first = Math.max(0, Math.min(tops.length - TITLE_LINES, first));
  if (Math.abs(first * line - now) > 0.5) t.scrollTop = first * line;
}

// a card's title is fitted again whenever the card changes size, and a card coming
// on show changes from no size at all, so a title is fitted as its card shows and
// as the window is resized. the card's own size never follows its title, so a fit
// made from here never asks for another
let titleWatch = null;
const titleOfBox = new WeakMap();
function watchTitle(el){
  if (typeof ResizeObserver !== "function" || !el.box || !el.titleEl) return;
  if (!titleWatch) titleWatch = new ResizeObserver(list => { for (const e of list) fitTitle(titleOfBox.get(e.target)); });
  titleOfBox.set(el.box, el.titleEl);
  titleWatch.observe(el.box);
}

// ---- one limit for the Mac and the phone ------------------------------------------
// a title takes words only while they sit on two lines at TITLE_MIN on both cards
// it is shown on, the Mac board's open card and the phone app's card, whichever
// fills first, so a title typed on either page fits two lines at 20px or more on the
// other. the two rooms are numbers of the two sheets, written once here where both
// pages read them, and not read off the page in hand, which would give the limit of
// whatever window or phone the title happened to be typed on:
//   mac: the conversation card at the size it starts at. the board lays its stage
//     out at 1440 by 900 and scales it to the window, so this room is the same in
//     every window: the title's 459.8px less its two 15.36px side insets
//   phone: the card on a 375 point wide phone, the narrowest phone the app runs on
//     (every iPhone that runs iOS 26 is 375 or wider) and the owner's own: WebKit
//     lays the title out 356.25px wide there, less its two 11.82px side insets. a
//     wider phone has more room
// both cards set the title in the same face and weight, and wrap a word too long for
// a line as their sheets do: the phone breaks it anywhere, the Mac lets it run.
// Chrome on the Mac and WebKit on the phone lay the same words out within a fiftieth
// of a pixel of each other (0.016px at most over 244 lines of titles), so each room
// keeps TITLE_SPARE of it unused, and a title one of them lets in fits on the other.
// both lay lines out in sixty-fourths of a pixel and round a width half of one apart,
// so the edge is set halfway between two sixty-fourths (titleEdge): no line ends on
// it, and both judge every title alike
const TITLE_CARDS = [
  { card: "mac", room: 429.07, wrap: "normal" },
  { card: "phone", room: 332.6, wrap: "anywhere" },
];
const TITLE_SPARE = 0.1;
const titleEdge = card => (Math.floor((card.room - TITLE_SPARE) * 64) + 0.5) / 64;

// an emoji is drawn a quarter wider by WebKit than by Chrome (25px against 20 at 20px,
// the same for faces, hands, flags and families), so the copy gives each one the
// wider width, a box 1.25em wide that breaks a line as an emoji does: a title let in
// on the Mac then fits on the phone
const TITLE_EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u{20e3}/u;
function titleWidestEmoji(copy){
  if (typeof Intl !== "object" || typeof Intl.Segmenter !== "function") return;
  const texts = [];
  (function walk(n){ for (const c of [...n.childNodes]) if (c.nodeType === 3) texts.push(c); else walk(c); })(copy);
  for (const node of texts){
    if (!TITLE_EMOJI.test(node.data)) continue;
    const part = document.createDocumentFragment();
    let run = "";
    for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(node.data)){
      if (!TITLE_EMOJI.test(segment)){ run += segment; continue; }
      if (run) part.appendChild(document.createTextNode(run));
      run = "";
      const box = document.createElement("span");
      box.style.cssText = "display:inline-block; width:1.25em; height:1em";
      part.appendChild(box);
    }
    if (run) part.appendChild(document.createTextNode(run));
    node.parentNode.replaceChild(part, node);
  }
}

// the lines a title would take on a card's room at TITLE_MIN with `text` in place of
// the range r inside it, laid out in a copy at the page's top level: the title's own
// element, editing state, font and words, so the copy breaks its lines as the title
// would, at the card's width and with its wrapping, while the title, its caret and
// its undo are left alone. a line break goes in as the editor puts one in, and one
// at the end stands the caret on a line of its own, which counts
function titleLinesWith(t, r, text, card){
  const cs = getComputedStyle(t);
  const copy = t.cloneNode(true);
  const twin = n => {
    const path = [];
    for (; n !== t; n = n.parentNode) path.unshift([...n.parentNode.childNodes].indexOf(n));
    return path.reduce((m, i) => m.childNodes[i], copy);
  };
  const cut = document.createRange();
  cut.setStart(twin(r.startContainer), r.startOffset);
  cut.setEnd(twin(r.endContainer), r.endOffset);
  cut.deleteContents();
  const part = document.createDocumentFragment();
  text.split(/\r\n|[\r\n\u2028\u2029]/).forEach((line, i, all) => {
    if (i) part.appendChild(document.createElement("br"));
    if (line || (i && i === all.length - 1)) part.appendChild(document.createTextNode(line || "\u200b"));
  });
  cut.insertNode(part);
  titleWidestEmoji(copy);
  // no class, so neither page's own title rules reach it: everything that places a
  // line break is written out, the face from the title as the page draws it
  copy.removeAttribute("class");
  copy.removeAttribute("tabindex");
  copy.setAttribute("aria-hidden", "true");
  const face = typeof cs.getPropertyValue !== "function" ? "" : ["font-family", "font-weight", "font-style",
    "font-stretch", "letter-spacing", "word-spacing", "font-kerning", "font-feature-settings",
    "font-variation-settings", "font-optical-sizing", "text-rendering", "text-transform"]
    .map(p => p + ":" + cs.getPropertyValue(p) + ";").join(" ");
  copy.style.cssText = "display:block; position:fixed; left:0; top:0; visibility:hidden; pointer-events:none;" +
    " margin:0; padding:0; border:0; box-sizing:content-box; max-height:none; overflow:visible; " + face +
    " white-space:normal; word-break:normal; hyphens:manual; overflow-wrap:" + card.wrap + "; width:" +
    titleEdge(card) + "px; font-size:" + TITLE_MIN + "px; line-height:" + TITLE_MIN * 1.25 + "px";
  document.body.appendChild(copy);
  const lines = titleLines(copy);
  copy.remove();
  return lines;
}

// whether a title would still fit with `text` in place of the range r: two lines at
// TITLE_MIN on every card it is shown on
function titleFitsCards(t, r, text){
  return TITLE_CARDS.every(card => titleLinesWith(t, r, text, card) <= TITLE_LINES);
}

// how much of `text` a title being renamed takes in place of the range r, or of the
// selection when no range is given: titleRoom, by the one limit of both cards
function titleRoomAt(t, text, r){
  if (!r){
    const sel = getSelection();
    if (!sel || !sel.rangeCount) return text;
    r = sel.getRangeAt(0);
  }
  if (!t.contains(r.startContainer) || !t.contains(r.endContainer)) return text;
  const taken = document.createRange();
  taken.setStart(r.startContainer, r.startOffset);
  taken.setEnd(r.endContainer, r.endOffset);
  return titleRoom(part => titleFitsCards(t, r, part), text, taken.toString().length);
}

// the typing limit, on beforeinput in a title being renamed: what would put words
// in is cut to what fits, which for a key is all of it or nothing. deleting, the
// arrows, a selection and every key of the card are not input and go on as ever.
// a word an input method is still composing cannot be held back (the browser does
// not let that input be cancelled); it is fitted as the rest are
function titleLimit(e, t){
  if (!t.isContentEditable || e.defaultPrevented || e.isComposing || !/^insert/.test(e.inputType || "")) return;
  const text = e.data != null ? e.data
    : e.dataTransfer ? e.dataTransfer.getData("text/plain")
    : /^insert(LineBreak|Paragraph)$/.test(e.inputType) ? "\n" : "";
  if (!text) return;
  const r = (typeof e.getTargetRanges === "function" && e.getTargetRanges()[0]) || null;
  const room = titleRoomAt(t, text, r);
  if (room === text) return;
  e.preventDefault();
  if (room) document.execCommand("insertText", false, room);
}

// a just-created card: the cursor starts in the title; Enter saves the name
// and drops the cursor into the message input
function editTitle(id, opts){
  opts = opts || {};
  const el = els[id]; if (!el) return;
  const t = el.titleEl, old = t.textContent;
  el.cycleStop = false;   // naming the card is a new start, not the loop's card stop
  t.setAttribute("contenteditable", "plaintext-only");
  // the phone's grey guess at the rest of a word is drawn inside the line after the
  // fit has measured it, and can carry the word on to a third line, so the title
  // asks for none. the keyboard reads this as the focus arrives, so it comes first
  t.setAttribute("writingsuggestions", "false");
  if (old === "…") t.textContent = "";
  // a title cut at its second line keeps its two line box while it is renamed and
  // scrolls in it to the caret; what would be typed or pasted is held to two lines
  fitTitle(t);
  if (!t.titleLimited && typeof t.addEventListener === "function"){
    t.titleLimited = true;
    t.addEventListener("beforeinput", e => titleLimit(e, t));
    t.addEventListener("scroll", () => titleScrolled(t), { passive: true });
  }
  // a click edits in place with the caret where you click; other entries (new card, tab) focus and select all
  if (!opts.fromClick){
    t.focus();
    if (t.textContent){
      const range = document.createRange();
      range.selectNodeContents(t);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
    }
  }
  let inputSeen = false;
  t.oninput = () => {
    fitTitle(t);
    if (inputSeen) return;
    inputSeen = true;
    try { window.phoneHistory?.note("stage", { stage: "title-input", box: id,
      inputReady: t.isConnected && t.isContentEditable, active: document.activeElement === t }); } catch (_) {}
  };
  const end = () => { t.removeAttribute("contenteditable"); t.onkeydown = null; t.onblur = null; t.oninput = null; };
  const commit = () => {
    const name = t.textContent.trim();
    end();
    if (name && name !== old){
      t.textContent = name;
      if (el.tocTitle) el.tocTitle.textContent = name;
      // focus is leaving the title, by Tab, Enter or a click away, and a name
      // crossing into or out of Omni sweeps the card over in the same moment
      omniRetitleCard(id, old, name);
      fetch("/title?box=" + encodeURIComponent(id), { method: "POST", body: name })
        .then(() => poll()).catch(() => {});
    } else if (!name && !old){
      // naming walked away from: the server hands out a whimsical name
      fetch("/title?box=" + encodeURIComponent(id), { method: "POST" })
        .then(() => poll()).catch(() => {});
    } else t.textContent = old;
    fitTitle(t);
  };
  t.onkeydown = e => {
    // a key an input method takes is the name's own (imeKey): its Enter does
    // not save the name, nor its Escape throw it away
    if (imeKey(e)){ e.stopPropagation(); return; }
    // control+shift+enter keeps the name as Enter does, then goes on to the
    // page's own control+shift+enter, the move to the card that has waited
    // longest. control+enter alone is the system's
    if (bareControlEnter(e)) return;
    if (controlShiftEnter(e)){ commit(); el.ta.focus(); return; }
    // the name keeps the keys it is typed with; a command of the page's goes on
    if (!pageChord(e)) e.stopPropagation();
    if (e.key === "Enter" && !e.altKey){ e.preventDefault(); commit(); el.ta.focus(); }
    else if (keyboardTitle && e.key === "Tab"){ e.preventDefault(); commit(); if (e.shiftKey) cardStop(el); else el.ta.focus(); }
    else if (e.key === "Escape"){
      if (!old && !t.textContent.trim()) commit();
      else { end(); t.textContent = old; fitTitle(t); }
      if (keyboardTitle) el.ta.focus();
    }
  };
  t.onblur = () => { if (t.isContentEditable) commit(); };
}

// Tab on a card walks three stops and no others: the title, the box the reader types
// in, and the card itself with nothing focused (so the card's keys act on it), and
// round again, with shift Tab walking them the other way: title, card, box. the
// buttons of the top row, the plus and the send arrow keep their clicks, taps and own
// keys and are only no longer stops. with nothing focused, or on any spot of the card
// that is not a stop, the card is where the reader is: shift Tab lands on the box, and
// Tab lands on the title, except on a card that already has a title when the reader
// has just come to it (opened, or a click on its reply or bare face), where the first
// Tab lands on the box: a card being revisited is not renamed, while a card just made
// starts with the caret in its title and so follows the loop from there. a card the
// loop itself left (cardStop) is still the loop's third stop, and its Tab goes on to
// the title. out of the title the page makes the move itself (editTitle on the desktop,
// the Tab listener ahead of it on the phone). answers true when it moved the focus;
// toBox is how the page puts the caret in the box
function cardTab(e, id, toBox){
  if (e.key !== "Tab" || e.ctrlKey || e.metaKey || e.altKey || e.isComposing || e.defaultPrevented) return false;
  const el = els[id];
  if (!el || el.titleEl.contains(e.target)) return false;
  e.preventDefault();
  const inBox = el.field.focused();
  const inLoop = el.cycleStop;   // the loop left the card here, with nothing since
  el.cycleStop = false;
  if (inBox && !e.shiftKey) cardStop(el);
  else if (!inBox && e.shiftKey) toBox(el);
  else if (!inBox && !inLoop && cardTitled(el)) toBox(el);
  else if (el.titleEl.isContentEditable) el.titleEl.focus();
  else editTitle(id);
  return true;
}

// a card has a title when its name is not empty. the board makes a new card with an
// empty title (the server's create), the page shows that as an empty title, and the
// ellipsis is the same empty name editTitle clears when the reader starts naming
function cardTitled(el){
  const name = el.titleEl.textContent.trim();
  return name !== "" && name !== "…";
}

// the card itself: whatever holds the focus lets go of it and nothing is focused, so
// the card's keys act on the card as they do after a click on its bare face. a title
// being renamed keeps its name as it blurs (editTitle's blur) and drops its
// selection; a half-typed message stays in the box. the card is marked as left by the
// loop, so the next Tab goes on to the title (see cardTab)
function cardStop(el){
  el.cycleStop = true;
  const live = document.activeElement;
  if (live && typeof live.blur === "function" && live !== document.body) live.blur();
  if (live === el.titleEl) getSelection().removeAllRanges();
}

// the reader comes to the card afresh: it is shown again (each page's select, on
// coming back to it from another card too) or pressed with the pointer or a finger.
// a card stop the loop left behind is forgotten, so the first Tab on a card with a
// name lands in the box again (cardTab)
function cardTabAfresh(el){
  if (el) el.cycleStop = false;
}

// a key typed in a text field, a list or a dialog is that control's own, and
// Tab out of it is never taken from it
function cardTabOwned(target){
  return cardShortcutEditing(target) || (!!target && typeof target.closest === "function" &&
    !!target.closest("select, summary, dialog, [role='dialog'], [role='menu'], [role='listbox']"));
}

// Tab from anywhere else on the page goes the way it goes from a button on the
// card: the focus is nowhere after a load, a click on the answer, on bare card or
// on a ticket, or with Home just left; or it sits on a button outside the card,
// which a shut menu hands it back to. the browser's own Tab would start from where
// the reader last clicked and stop on the plus before the text box. the page asks
// this only while the card on screen holds the keys, and a text field keeps its Tab
function cardTabAway(e, id, toBox){
  const el = els[id];
  if (!el || el.box.contains(e.target) || cardTabOwned(e.target)) return false;
  return cardTab(e, id, toBox);
}

// nothing on a card but its text box and its title is a Tab stop: the buttons of
// the top row, the plus, the send arrow, and what the card draws later (links in
// an answer, copy buttons, the tray's and the sent panel's controls), which is
// quieted as it arrives. they keep their clicks, taps and own keys
const CARD_STOPS = "a[href], area[href], button, input, select, summary, textarea";
function quietStops(el){
  const keeps = n => n === el.titleEl || n === el.ta || !!(n.closest && n.closest(".cm-editor"));
  const quiet = root => {
    if (root.nodeType !== 1) return;
    for (const n of [root, ...root.querySelectorAll(CARD_STOPS)])
      if (n.matches(CARD_STOPS) && !keeps(n)) n.tabIndex = -1;
  };
  quiet(el.box);
  new MutationObserver(list => {
    for (const m of list) for (const n of m.addedNodes) quiet(n);
  }).observe(el.box, { childList: true, subtree: true });
}

// ---- the response's caret and the card's three places ---------------------------
// the response takes a caret the reader moves and selects with and never types
// with. while the caret stands in it the answer is editable, so the browser draws
// its own caret there and every key it has for text is the system's own: shift
// with the arrows, with option a word at a time and with command to a line's or
// the answer's ends, command+a for the answer alone, command+c. nothing typed,
// pasted, dropped, cut, deleted, formatted or undone changes the answer (each
// beforeinput is refused, and so is a cut), no on-screen keyboard is asked for,
// and the answer is plain prose again the moment the caret leaves it
const REPLY_CARET = { contenteditable: "true", inputmode: "none", spellcheck: "false", autocorrect: "off",
  autocapitalize: "off", writingsuggestions: "false", role: "textbox", "aria-multiline": "true",
  "aria-readonly": "true" };

let replyCaretCard = null;   // the card whose answer was last made editable

// the caret into the card's response: where it stood when the reader last left the
// answer, or else at the first line on show (replyCaretStart)
function replyCaret(el){
  const r = el.reply;
  readOnlyReply(el);
  el.cycleStop = false;   // a place the reader chose, not the loop's card stop
  // a card hidden with the caret in its answer can lose the focus with no blur
  // to say so; its answer is made plain here instead
  if (replyCaretCard && replyCaretCard !== el) replyCaretOff(replyCaretCard);
  replyCaretCard = el;
  for (const [name, value] of Object.entries(REPLY_CARET)) r.setAttribute(name, value);
  r.focus({ preventScroll: true });
  const kept = el.replyMark;
  const at = kept && r.contains(kept.startContainer) && r.contains(kept.endContainer) ? kept : replyCaretStart(el);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(at);
}

// the first line of the answer the reader can see: its first letter when the answer
// has not been scrolled, else the line under the top of the scroller, read at the
// start of the prose's own column. a caret between the answer's blocks rather than
// in its words has no spot of its own to be drawn at (the Mac board's block caret
// is drawn off that spot), so the head is the first letter and not the edge
function replyCaretStart(el){
  const r = el.reply, view = el.replyview;
  const head = document.createRange();
  head.selectNodeContents(r);
  head.collapse(true);
  const words = document.createTreeWalker(r, NodeFilter.SHOW_TEXT);
  for (let t = words.nextNode(); t; t = words.nextNode()){
    const at = t.data.search(/\S/);
    if (at >= 0){ head.setStart(t, at); head.collapse(true); break; }
  }
  if (!view || view.scrollTop < 1 || typeof document.caretRangeFromPoint !== "function") return head;
  const vr = view.getBoundingClientRect(), rr = r.getBoundingClientRect(), cs = getComputedStyle(r);
  const x = rr.left + (parseFloat(cs.paddingLeft) || 0) + 1;
  const step = (parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5 || 24) / 2;
  for (let y = Math.max(vr.top, rr.top) + step; y < vr.bottom; y += step){
    const at = document.caretRangeFromPoint(x, y);
    if (at && r.contains(at.startContainer)) return at;
  }
  return head;
}

// the answer kept as it is while its caret stands in it, wired the first time the
// caret goes in. a word an input method is composing cannot be refused (the
// browser does not let that input be cancelled), so the answer is put back as it
// was once the word ends. where the caret stands is kept as it moves, for the next
// time the reader comes back (by the time the answer hears its blur the focus has
// taken the selection along). leaving the answer takes the editing off again; a
// window put behind another keeps the caret, as a text field does
let replyCaretKept = false;
function readOnlyReply(el){
  const r = el.reply;
  if (!replyCaretKept){
    replyCaretKept = true;
    document.addEventListener("selectionchange", () => {
      const on = replyCaretCard, sel = getSelection();
      if (on && document.activeElement === on.reply && sel.rangeCount && on.reply.contains(sel.getRangeAt(0).startContainer))
        on.replyMark = sel.getRangeAt(0).cloneRange();
    });
  }
  if (r.readOnlyKept) return;
  r.readOnlyKept = true;
  r.addEventListener("beforeinput", e => { if (r.isContentEditable) e.preventDefault(); });
  r.addEventListener("cut", e => { if (r.isContentEditable) e.preventDefault(); });
  let before = null;
  r.addEventListener("compositionstart", () => { if (r.isContentEditable) before = r.innerHTML; });
  r.addEventListener("compositionend", () => {
    const html = before;
    before = null;
    if (html !== null) setTimeout(() => { if (r.innerHTML !== html) r.innerHTML = html; });
  });
  r.addEventListener("blur", () => {
    if (!r.isContentEditable || document.activeElement === r || !document.hasFocus()) return;
    replyCaretOff(el);
  });
}
function replyCaretOff(el){
  for (const name of Object.keys(REPLY_CARET)) el.reply.removeAttribute(name);
}

// control+option+up and down move between the card's three places, the order they
// stand in from the top: the title, the response and the typing box. up goes from
// the box to the response to the title, down comes back, and the keys stop at
// either end. with nothing focused, or on a spot of the card that is none of the
// three (a button, a link), the reader stands between the response and the box:
// up lands in the response and down in the box. the title is opened as Tab opens
// it (editTitle) and the box takes the caret as the page's Tab puts it there
// (toBox); leaving the title keeps its name and leaving the box keeps a half-typed
// message, as Tab does. a response the page has put off the card (cardAnswerOff)
// is the response's place while it is there. answers true when it moved the focus
function cardPlace(id, step, toBox){
  const el = els[id];
  if (!el) return false;
  const off = typeof cardAnswerOff === "function" ? cardAnswerOff(id) : null;
  const live = document.activeElement;
  const answer = !!live && (off ? off.holds(live) : live === el.reply);
  const at = live && el.titleEl.contains(live) ? 0 : answer ? 1 : el.field.focused() ? 2 : 1.5;
  const to = at === 1.5 ? (step < 0 ? 1 : 2) : at + step;
  if (to < 0 || to > 2 || to === at) return false;
  if (to === 0){
    if (el.titleEl.isContentEditable) el.titleEl.focus();
    else editTitle(id);
  } else if (to === 1){
    if (off) off.go();
    else replyCaret(el);
  } else toBox(el);
  return true;
}

// after a send, move to the next YELLOW card: one awaiting the reader's read, never a
// green working card or a grey queued one. opts go to select as they are; the
// desktop asks for focus. answers with the card it landed on, or nothing when
// there was none to land on
function jumpNextYellow(fromId, opts, source){
  if (!lastState) return;
  // stay inside the tab being looked at: sending from doing must never land on
  // a deferred or done card
  const p = (source || viewPool(lastState)).filter(b =>
    !b.done && !(b.writing || b.bg) && b.ball === "you" && b.id !== fromId);
  if (!p.length) return;
  // the send should land on the card that has waited
  // longest, not the newest. agentTs is written in the same breath as the turn
  // going back to the reader, so it marks when a card became the reader's to read; ts moves on
  // the reader's own sends and on progress notes too, so it cannot mean that. a card the
  // agent has never answered has only its own ts to age by, and one carrying
  // neither stamp cannot be aged, so it sorts last instead of posing as the
  // oldest thing here. the filter above already made a fresh array, so nothing
  // else sees this sort, and equal stamps keep the list's own order. the reader's
  // choice of newest first (waitNewestFirst) turns the list over by stamp only,
  // so equal stamps stand as they did and the card this lands on is the same
  const listOrder = new Map(p.map((b, i) => [b.id, i]));
  p.sort((a, b) => waitingSince(a) - waitingSince(b) || listOrder.get(a.id) - listOrder.get(b.id));
  select(p[0].id, opts);
  return p[0].id;
}

// ---- older replies --------------------------------------------------------------------
// the card steps back through its past agent replies and returns toward live:
// the desktop on control shift up and down, the phone on the two arrows in the
// card's top bar. While an older reply shows, dataset.raw keeps holding the
// live text, so apply()'s rewrite guard leaves the view alone across polls; an
// actual new reply changes the raw, which drops the cached history and snaps
// the card back to live.
const histCache = {};   // box id -> promise of past agent replies, oldest first, live excluded
let hist = null;        // {id, step} while an older reply shows; step 1 = one back from live
// what a history request that failed answers with. Every caller that only
// walks the list sees the empty list it always saw, and a caller that has to
// tell "nothing older" apart from "could not find out" compares against this
// exact list: a request that failed says nothing about the card, so it must
// not be read as the card having no older replies
const HIST_UNKNOWN = Object.freeze([]);

// the pages this card's arrows can step back to, oldest first. The board
// answers it whole: only final replies, the live page already left out, and
// its length is the olderReplies count the card was sent with. Which rows are
// pages of a history, and which one the card is on, are decided in the one
// place that can be right about both, so a page never has to filter a window
// of mixed rows or guess the live page by matching its text
function histList(id){
  if (!histCache[id]){
    let request;
    request = fetch("/history?box=" + encodeURIComponent(id))
      .then(x => {
        if (!x.ok) throw new Error("history request failed");
        return x.json();
      })
      .then(r => {
        const replies = r.replies || [];
        // what each of those replies was given, and when each was completed,
        // one entry per reply and in the same order. it is carried ON the list
        // rather than in a cache beside it, so it cannot outlive the list: every
        // place that drops this card's cached history drops the batches in the
        // same breath. every caller that only walks the replies still gets
        // exactly the array of strings it always got, and a board too old to
        // send the entries leaves the list bare, which reads as unknown
        // everywhere rather than as a batch of none
        const meta = r.replyMeta;
        if (Array.isArray(meta) && meta.length === replies.length) replies.meta = meta;
        return replies;
      })
      .catch(() => {
        // A newer card version may already own this slot. An older rejection
        // must clear only its own failed request, then a later sync can retry.
        if (histCache[id] === request) delete histCache[id];
        return HIST_UNKNOWN;
      });
    histCache[id] = request;
  }
  return histCache[id];
}

function histExit(id){
  const was = hist && hist.id === id;
  if (was) hist = null;
  const el = els[id];
  if (!el) return;
  el.box.classList.remove("histview");
  el.histPos.textContent = "";
  el.histUp.disabled = false;
  el.histDown.disabled = true;
  if (was){
    el.reply.innerHTML = fmt(el.reply.dataset.raw);
    scrollCardTop(el);   // the answer's own scroller back to its top
    // back on the live reply, so the panel over it is the live reply's own batch
    // again. the card is read out of the state the page is holding rather than
    // remembered from the step away, so a reply that landed while an older page
    // was being read is the one that comes back. while a new answer is held back
    // for the reader, the live page is still the one the card last drew, and so
    // is its batch, until the page turn brings the new one
    syncAnswered(el, el.turnHeld && el.liveMeta !== undefined ? el.liveMeta : liveAnswered(stateBoxOf(id)));
  }
}

async function histStep(id, dir){   // +1 steps older, -1 steps back toward live
  if (!id || !els[id]) return;
  const list = await histList(id);
  if (id !== selectedId || !els[id] || !list.length) return;   // card changed or nothing older
  const cur = hist && hist.id === id ? hist.step : 0;
  const step = Math.min(Math.max(cur + dir, 0), list.length);
  if (step === cur) return;
  if (!step){ histExit(id); return; }
  hist = { id, step };
  const el = els[id];
  el.reply.innerHTML = fmt(list[list.length - step]);
  scrollCardTop(el);   // the answer's own scroller back to its top
  // this page's own batch, so an older answer is read with the messages it was
  // actually given and never with the live card's
  syncAnswered(el, histAnswered(list, step));
  el.box.classList.add("histview");
  el.histPos.textContent = (list.length - step + 1) + " of " + (list.length + 1);
  el.histUp.disabled = step >= list.length;
  el.histDown.disabled = false;
}

// ---- the list's spinner ----------------------------------------------------------------
// while a row works its age is noise; the slot carries a terminal spinner
// instead. one interval serves every green row and only lives while one
// exists. each card turns on its own phase: its frame is the whole number of
// 180 ms steps between the card's last message or reply (its ts, which every
// reading carries) and the clock at the timer's last tick, so cards whose
// last word came at different times are out of step, and the same card shows
// the same frame after a reload and on either page. a ticket and its own
// card read the same card and the same tick, so they always match. a new
// message or reply on a working card moves its ts, and so its spinner by a
// step, once. a card with no ts falls back to counting ticks from when the
// page first drew it working, kept across renders and polls and forgotten
// once the card stops working. rows are drawn with their frame already in
// place, so the ticker and the poll-driven re-renders never fight over the
// text. ages return on the next quiet poll.
// the card's own spinner (cardSpinner below) turns on the same clock: the
// interval also lives while a card shows one, since a phone draws no rows while
// its drawer is shut.
const SPIN_FRAMES = ["|","/","-","\\"];   // the classic terminal spinner, bolder than braille dots
const SPIN_STEP_MS = 180;
let spinTick = 0, spinTimer = null, spinNow = 0;
const spinStarts = new Map();   // card id -> the tick it was first drawn working (no ts)
const spinTs = new Map();       // card id -> the ts its last reading carried
function spinNote(b){
  if (b && b.id && typeof b.ts === "number" && b.ts > 0) spinTs.set(b.id, b.ts);
}
// the clock every frame is read from: the one the last tick took, so a row and
// a card drawn between ticks still agree, and the present while no timer runs
function spinClock(){ return spinTimer != null && spinNow ? spinNow : Date.now(); }
function spinGlyph(id, b){
  spinNote(b);
  let ts = spinTs.get(id);
  if (ts === undefined && typeof lastState !== "undefined" && lastState && lastState.boxes){
    const known = lastState.boxes.find(x => x.id === id);
    if (known && typeof known.ts === "number" && known.ts > 0) ts = known.ts;
  }
  const n = SPIN_FRAMES.length;
  if (ts > 0){
    const step = Math.floor((spinClock() - ts * 1000) / SPIN_STEP_MS);
    return SPIN_FRAMES[((step % n) + n) % n];
  }
  if (!spinStarts.has(id)) spinStarts.set(id, spinTick);
  return SPIN_FRAMES[(spinTick - spinStarts.get(id)) % n];
}
function spinCardId(el){
  const box = el.closest("article.box");
  return box && box.id ? box.id.slice(4) : "";
}
// forget every card that no longer works, then (when asked) stamp the frame of
// each one that does. a card the board still reports green counts as working
// even while no row or card on the page shows it
function spinRefresh(stamp){
  const rows = document.querySelectorAll("#tiklist .trow.working");
  const cards = document.querySelectorAll(".cardspin.on");
  const live = new Set();
  for (const r of rows) live.add(r.dataset.id);
  for (const c of cards) live.add(spinCardId(c));
  if (typeof lastState !== "undefined" && lastState && lastState.boxes){
    for (const b of lastState.boxes) if (ticketGreen(b)) live.add(b.id);
  }
  for (const id of [...spinStarts.keys()]) if (!live.has(id)) spinStarts.delete(id);
  for (const id of [...spinTs.keys()]) if (!live.has(id)) spinTs.delete(id);
  if (!stamp) return;
  for (const r of rows){
    const age = r.querySelector(".tage");
    if (age && r.dataset.id) age.textContent = spinGlyph(r.dataset.id);
  }
  for (const c of cards){
    const id = spinCardId(c);
    if (id) c.dataset.f = spinGlyph(id);
  }
}
function syncSpinner(){
  const has = document.querySelector("#tiklist .trow.working, .cardspin.on");
  if (has && spinTimer == null){
    spinNow = Date.now();
    spinTimer = setInterval(() => {
      if (!document.querySelector("#tiklist .trow.working .tage, .cardspin.on")){ clearInterval(spinTimer); spinTimer = null; return; }
      spinTick++;
      spinNow = Date.now();
      spinRefresh(true);
    }, SPIN_STEP_MS);
  } else if (!has && spinTimer != null){
    clearInterval(spinTimer); spinTimer = null;
  }
  spinRefresh(true);
}

// ---- the card's own spinner ------------------------------------------------------------
// the list's green ticket has a twin in the card's top bar, in the sun's place:
// the same four frames on the same clock and from the same start, drawn by the shared sheet
// (card-tokens.css, .cardspin) from the frame written in data-f. it is always
// in the bar and only its strength changes, so it fades in, as the sun's mark
// fades out, when the card turns green and out when the reply comes back, and
// shows or hides without moving anything. a done or deferred card never shows
// it, even where its ticket still pulses under a claim the agent holds.
function cardSpinning(b){
  const s = cardState(b);
  const on = s !== "done" && s !== "parked" && ticketGreen(b);
  if (on) spinNote(b);   // the card's ts is what its frame is counted from
  return on;
}
function makeCardSpinner(){
  const spin = h("span", "cardspin");
  spin.setAttribute("role", "img");
  spin.setAttribute("aria-label", "working");
  spin.setAttribute("aria-hidden", "true");
  spin.dataset.f = SPIN_FRAMES[0];
  return spin;
}
function setCardSpinner(spin, on){
  if (!spin || spin.classList.contains("on") === on) return;
  if (on){
    const id = spinCardId(spin);
    spin.dataset.f = id ? spinGlyph(id) : SPIN_FRAMES[0];
  }
  spin.classList.toggle("on", on);
  spin.setAttribute("aria-hidden", on ? "false" : "true");
}

// ---- quick notes ------------------------------------------------------------------
// a quick note is plain text the owner jots down without leaving what they are
// doing. it stands alone unless its words name a card: "card 12", "card12" or
// "c12" attaches it to the card the board numbers 12, the way a date typed into
// a task is picked out of its words. kept here, where both pages can reach it,
// is everything that is not the desktop's pointer corner or its card chip:
// reading a reference out of the text, finding the card it names, what an edit
// does to the attachment, the session that saves as the owner types, and the
// overlay itself, so the phone can open the same element once it has a way in.
// hidden in this version: no page builds the overlay or starts a session, and
// the server answers 404 on every quick note route (QUICK_NOTES_ON, server.py).

// the reference: card, card and a space, or c, then the number, standing as a
// word of its own. a letter, digit or underscore on either side makes it part of
// a longer word (abc12, c12b, discard 5) and a dot then a digit part of a longer
// number (c1.2), and neither is read as a card. there is no lookbehind in it, so
// an older phone engine can still read this file.
// the number is the board's card numbering, which is defined elsewhere: ids are
// made in server.py _create_box_record (m plus the next_bid counter kept in
// _migrate, and seeded ids as written in _seed_state), and the figure shown for
// an id is ticketNum in this file (copied in page.html). when that numbering
// changes, this parser, quickNoteCard below, the attach routes in server.py and
// parked/quick-note.js syncQuickNoteChip have to change with it
const QUICK_NOTE_REF = /(^|[^\p{L}\p{N}_])(?:card[ \t\u00a0]*|c)(\d+)(?![\p{L}\p{N}_]|\.\d)/iu;
function quickNoteRef(text){
  const m = QUICK_NOTE_REF.exec(String(text == null ? "" : text));
  return m ? m[2] : null;
}
// the card the board numbers num: the figure ticketNum reads off a card's id,
// m12 for a card made on the board and a seeded numeric id as it is. ids are
// never reused, so two cards share a figure only when a seeded 12 and a made m12
// both stand, and then the one made on the board is the one meant
function quickNoteCard(boxes, num){
  const want = String(num == null ? "" : num);
  if (!want) return null;
  let found = null;
  for (const b of boxes || []){
    if (ticketNum(b.id) !== want) continue;
    if (b.id === "m" + want) return b;
    if (!found) found = b;
  }
  return found;
}
// what one saved edit asks of the note's attachment. before and after are the
// note's words when the attachment was last read and now, card the card it is
// attached to. only a change in the reference acts, so a note attached some
// other way, by an agent later, is left where it is until its words name a card
// of their own. all of it happens silently: the note shows none of it:
//   {attach: id}    the words name a card the note is not attached to yet
//   {detach: true}  the reference that attached it has been deleted
//   {missing: "N"}  the words name a figure no card on the board carries
//   null            nothing to do
// the first reference in the words is the one that counts
function quickNoteAttachStep(before, after, card, boxes){
  const was = quickNoteRef(before), now = quickNoteRef(after);
  if (now === was) return null;
  if (now == null){
    const left = quickNoteCard(boxes, was);
    return left && left.id === card ? { detach: true } : null;
  }
  const hit = quickNoteCard(boxes, now);
  if (!hit) return { missing: now };
  return hit.id === card ? null : { attach: hit.id };
}
// the list the way it is read: the note touched last on top
function quickNotesNewestFirst(notes){
  const seq = n => Number(String((n && n.id) || "").slice(2)) || 0;
  return (notes || []).filter(Boolean).slice()
    .sort((a, b) => (b.updated || 0) - (a.updated || 0) || seq(b) - seq(a));
}
// card id to the notes attached to it, newest first
function quickNotesByCard(notes){
  const out = {};
  for (const n of quickNotesNewestFirst(notes)){
    if (!n.card) continue;
    (out[n.card] || (out[n.card] = [])).push(n);
  }
  return out;
}

const QUICK_NOTE_KEY = "quicknote.current";   // the note being written, per browser
const QUICK_NOTE_SAVE_MS = 600;               // a pause in the typing this long saves it
// the note being written, saved as the owner types. one request is out at a
// time and each save sends the words as they are by then, so a slow answer can
// never put older words over newer ones. the first save is the one that makes
// the note, so a note nobody typed in is never stored, and a note emptied and
// put away is removed rather than kept blank. words that could not be saved are
// never overwritten from the board: they stay on screen and go again with the
// next save. deps: fetch, storage (a localStorage), boxes() (the cards the
// board holds now), schedule(fn, ms) and cancel(id) (a timer)
function quickNoteSession(deps){
  const s = { id: null, text: "", saved: "", card: null, status: "", notes: [], onChange: null };
  let readFrom = "", timer = null, chain = Promise.resolve();
  const changed = () => { if (typeof s.onChange === "function") s.onChange(s); };
  const recall = () => { try { return deps.storage.getItem(QUICK_NOTE_KEY); } catch (e){ return null; } };
  const remember = id => {
    try {
      if (id) deps.storage.setItem(QUICK_NOTE_KEY, id);
      else deps.storage.removeItem(QUICK_NOTE_KEY);
    } catch (e){}
  };
  // one step at a time, in the order asked; a step that throws never stops the
  // ones queued behind it
  const run = step => (chain = chain.then(step).catch(() => {}));
  const unsaved = () => (s.id == null ? s.text.trim() !== "" : s.text !== s.saved);
  async function post(url, body){
    const init = { method: "POST" };
    if (body != null) init.body = body;
    const r = await deps.fetch(url, init);
    const data = await r.json().catch(() => null);
    if (!r.ok || !data || !data.ok) throw new Error((data && data.error) || "status " + r.status);
    return data;
  }
  async function load(){
    const r = await deps.fetch("/quicknotes", { cache: "no-store" });
    const data = await r.json().catch(() => null);
    if (!r.ok || !data || !Array.isArray(data.notes)) throw new Error("status " + r.status);
    s.notes = quickNotesNewestFirst(data.notes);
  }
  function show(note){
    s.id = note ? note.id : null;
    s.text = s.saved = readFrom = note ? String(note.text || "") : "";
    s.card = note ? note.card || null : null;
    remember(s.id);
  }
  // a figure no card carries asks nothing, and the note says nothing about it
  async function attachStep(text){
    const step = quickNoteAttachStep(readFrom, text, s.card, deps.boxes());
    if (step && !step.missing){
      const card = step.attach || null;
      await post("/quicknote/attach?id=" + encodeURIComponent(s.id) +
                 (card ? "&card=" + encodeURIComponent(card) : ""));
      s.card = card;
    }
    // read only once acted on, so an attach that failed is tried again next save
    readFrom = text;
  }
  async function saveNow(){
    if (timer != null){ deps.cancel(timer); timer = null; }
    const text = s.text;
    try {
      if (s.id == null){
        if (!text.trim()) return;
        s.status = "saving"; changed();
        const made = await post("/quicknote/new", text);
        s.id = made.note.id;
        remember(s.id);
      } else if (text !== s.saved){
        s.status = "saving"; changed();
        await post("/quicknote/save?id=" + encodeURIComponent(s.id), text);
      }
      s.saved = text;
      await attachStep(text);
      s.status = "saved";
    } catch (e){
      s.status = "failed";
    }
    changed();
  }
  async function dropIfEmpty(){
    if (s.id == null || s.text.trim() || unsaved()) return;
    const id = s.id;
    await post("/quicknote/del?id=" + encodeURIComponent(id));
    s.notes = s.notes.filter(n => n.id !== id);
    show(null);
    s.status = "";
  }
  s.input = text => {
    s.text = String(text == null ? "" : text);
    if (timer != null) deps.cancel(timer);
    timer = deps.schedule(() => { timer = null; run(saveNow); }, QUICK_NOTE_SAVE_MS);
  };
  s.flush = () => run(saveNow);
  // opening: words still waiting go first, then the list is read fresh and the
  // note being written is shown as the board holds it now, which is what lets
  // someone else's later edit to it be seen rather than written over
  s.open = () => run(async () => {
    await saveNow();
    try { await load(); } catch (e){ s.status = "failed"; changed(); return; }
    if (!unsaved()){
      const want = s.id || recall();
      show((want && s.notes.find(n => n.id === want)) || null);
    }
    changed();
  });
  s.openNote = id => run(async () => {
    await saveNow();
    if (unsaved()){ changed(); return; }
    if (id !== s.id){ try { await dropIfEmpty(); } catch (e){} }
    try { await load(); } catch (e){ s.status = "failed"; changed(); return; }
    const note = s.notes.find(n => n.id === id);
    if (note) show(note);
    changed();
  });
  s.close = () => run(async () => {
    await saveNow();
    try { await dropIfEmpty(); } catch (e){}
    changed();
  });
  // walking the notes with no chrome to walk them by: dir 1 is the next older
  // note and -1 the next newer, newest first as the board last read them, and
  // one newer than the newest is a blank note, which is how a new one is
  // started. past the oldest, or newer than a blank note, nothing moves. the
  // words on screen go first, and words that cannot be saved hold the note
  // where it is, so a step can never walk away from them
  s.step = dir => run(async () => {
    await saveNow();
    if (unsaved()){ changed(); return; }
    try { await load(); } catch (e){ s.status = "failed"; changed(); return; }
    const at = s.id == null ? -1 : s.notes.findIndex(n => n.id === s.id);
    const to = at + (dir > 0 ? 1 : -1);
    if (to >= s.notes.length || to < -1 || (to === -1 && s.id == null)){ changed(); return; }
    const next = to >= 0 ? s.notes[to] : null;
    try { await dropIfEmpty(); } catch (e){}
    show(next);
    s.status = "";
    changed();
  });
  return s;
}

// the overlay: one plain card in the middle of the window over a veil that
// covers the board, and on the card nothing but the words and the caret. no
// title, no buttons, no status, no hint: the note is the text area, and the
// card's glass is the whole of its look. built once into host by the page that
// shows it. what comes back opens it, on the note being written or on one note
// by id, pulled out of the rectangle it was pressed from when one is given;
// closes it; and says whether it is open. opts carries what the session needs,
// plus onOpen, onClose, onChange and onMoved for the page's own bookkeeping,
// its keys and its caret above all. nothing runs until a page calls this
function quickNoteOverlay(host, opts){
  const session = quickNoteSession(opts);
  const veil = h("div", "qn-veil");
  veil.setAttribute("aria-hidden", "true");
  const card = h("div", "qn-card qn-glass");
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-label", "Quick note");
  const ta = h("textarea", "qn-text");
  ta.setAttribute("aria-label", "quick note");
  card.appendChild(ta);
  veil.appendChild(card);
  host.appendChild(veil);

  let open = false, back = null, downOutside = false;
  // the one mark the card ever wears: while words on it could not be saved,
  // its hairline rim turns the board's warning red, and it goes back the
  // moment a save lands. no words, and nothing that stays once it is true again
  function render(){ card.classList.toggle("failed", session.status === "failed"); }
  session.onChange = () => { render(); if (opts.onChange) opts.onChange(session); };
  function caretEnd(){
    ta.focus();
    const end = ta.value.length;
    if (typeof ta.setSelectionRange === "function") ta.setSelectionRange(end, end);
  }
  // a switch of note puts the board's words in the field; the field takes no
  // typing while that is under way, so nothing typed can land in the gap
  async function settle(step){
    ta.readOnly = true;
    await step;
    ta.readOnly = false;
    if (ta.value !== session.text) ta.value = session.text;
    render();
  }
  // the pull from where it was pressed into the middle, as one short glide
  function pull(from){
    if (!from || typeof card.animate !== "function") return;
    if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const to = card.getBoundingClientRect();
    if (!to.width || !to.height) return;
    const dx = (from.left + from.width / 2) - (to.left + to.width / 2);
    const dy = (from.top + from.height / 2) - (to.top + to.height / 2);
    const scale = Math.min(1, Math.max(.2, from.width / to.width));
    const glide = card.animate([{ transform: "translate(" + dx + "px, " + dy + "px) scale(" + scale + ")", opacity: .6 },
                                { transform: "none", opacity: 1 }],
                               { duration: 220, easing: "cubic-bezier(.42,.06,.38,1)" });
    // a page that draws its own caret over the field placed it while the card
    // was still on its way; it is told once the card has come to rest
    if (glide && glide.finished && opts.onMoved) glide.finished.then(() => opts.onMoved(), () => {});
  }
  async function openOverlay(id, from){
    if (!open){
      open = true;
      back = document.activeElement;
      ta.value = session.text;
      veil.classList.add("open");
      veil.setAttribute("aria-hidden", "false");
      pull(from);
      ta.focus();
      if (opts.onOpen) opts.onOpen();
    }
    await settle(id ? session.openNote(id) : session.open());
    if (open) caretEnd();
  }
  function close(){
    if (!open) return Promise.resolve();
    open = false;
    veil.classList.remove("open");
    veil.setAttribute("aria-hidden", "true");
    if (opts.onClose) opts.onClose();
    const to = back;
    back = null;
    if (to && to.isConnected && typeof to.focus === "function") to.focus({ preventScroll: true });
    else if (card.contains(document.activeElement)) document.activeElement.blur();
    return session.close();
  }

  ta.addEventListener("input", () => session.input(ta.value));
  // the keys are the note's own while it is open: Escape puts it away, and no
  // key goes on to the board it covers. the board's own reply history chord,
  // control shift up and down, walks the notes the way it walks a card's
  // replies: up is the next older note, down the next newer, and down from the
  // newest is a blank note, which is the whole of starting a new one. nothing
  // on the card names it
  veil.addEventListener("keydown", e => {
    e.stopPropagation();
    if (e.key === "Escape"){ e.preventDefault(); close(); return; }
    const shortcut = cardShortcut(e);
    if (!shortcut || shortcut.action !== "history") return;
    e.preventDefault();
    settle(session.step(shortcut.value)).then(() => { if (open) caretEnd(); });
  });
  // a press that starts and ends on the veil, outside the card, puts it away;
  // a selection dragged out of the card and let go on the veil does not
  veil.addEventListener("pointerdown", e => { downOutside = e.target === veil; });
  veil.addEventListener("click", e => {
    if (downOutside && e.target === veil) close();
    downOutside = false;
  });
  // and focus cannot wander onto the board behind it
  document.addEventListener("focusin", e => {
    if (open && !card.contains(e.target)) ta.focus();
  });
  return { open: openOverlay, close, isOpen: () => open, session, root: veil };
}

// ---- the settings page ---------------------------------------------------------
// the board's own choices on one page, the same one on the desktop board, where
// it is an overlay, and on the phone, where it fills the screen. each page keeps
// its controls in the markup, grouped
// under one element per section carrying data-section and data-label, so every
// control keeps its id and its own wiring; this builds the page around them and
// moves each group into its pane. nothing here reads or writes a setting.
// the width it turns from a column of sections beside the settings to a list
// that opens one section at a time is 989px, the board's own single column width
const SETTINGS_NARROW_PX = 989;
const SETTINGS_NARROW = "(max-width: " + SETTINGS_NARROW_PX + "px)";
// the Mac's page is narrower than that on purpose, so it turns to the list by
// its own, smaller width
const SETTINGS_MAC_NARROW_PX = 600;
const SETTINGS_MARKS = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  next: '<path d="M9 5l7 7-7 7"/>',
};
// the Mac page's little mark to the left of each section's name: one line
// drawing to a section, on the same 24 grid and round ends as the marks above
const SETTINGS_ICONS = {
  profile: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="10" r="3"/><path d="M6.2 18.4c1.4-2.3 3.4-3.4 5.8-3.4s4.4 1.1 5.8 3.4"/>',
  appearance: '<path d="M12 3a9 9 0 1 0 0 18c1.2 0 1.9-.8 1.9-1.7 0-.5-.2-.9-.5-1.3-.3-.4-.4-.8-.4-1.2 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4c0-4.2-4-8-9-8z"/><path d="M7.5 11h.01M10 7.5h.01M14.5 7.5h.01"/>',
  editor: '<path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19z"/><path d="M14.5 6.5l3 3"/>',
  improvements: '<path d="M3.5 17l6-6 4 4 7-7.5"/><path d="M14.5 7.5h6v6"/>',
  // the garbage can the Mac board shows beside a ticket
  bin: '<path d="M3.5 6.5h17"/><path d="M9 6.5V4h6v2.5"/><path d="M6 6.5l1.1 14h9.8l1.1-14"/><path d="M10 10.5v6M14 10.5v6"/>',
  // the phone's own sections: a bell, a heartbeat for the diagnostics, a screen for the Mac
  notifications: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 21a2 2 0 0 0 4 0"/>',
  diagnostics: '<path d="M3 12h4.2l2.6-6.5 4.4 13 2.6-6.5H21"/>',
  mac: '<path d="M4 5h16v11H4z"/><path d="M9 20h6M12 16v4"/>',
};
// the twelve pictures the profile can hold (the number the board keeps with it,
// 19 to 30), each a mark on a light grey face drawn at half the face's side:
// content cat, ghost, snail, frog, chick, peeking bunny, sleepy face, cheeky
// wink, toast, cactus, rice ball, balloon. the Mac's page and the phone's
// drawer draw the same ones, and only show them
const SETTINGS_PICTURES = {
  19: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.2 9.6 5.6 4.8l4.4 3a6.6 6.6 0 0 1 4 0l4.4-3-.6 4.8c1.2 1.3 1.8 2.8 1.8 4.4 0 3.6-3.2 5.8-7.6 5.8S4.4 17.6 4.4 14c0-1.6.6-3.1 1.8-4.4Z"/><path d="M8.2 13q1.1-1.3 2.2 0M13.6 13q1.1-1.3 2.2 0M10.7 15.6q.65.9 1.3 0 .65.9 1.3 0"/></svg>',
  20: '<svg viewBox="0 0 24 24" aria-hidden="true"><g transform="rotate(-8 12 12)"><path d="M5.8 19.6V11a6.2 6.2 0 0 1 12.4 0v8.6l-2.07-1.5-2.07 1.5L12 18.1l-2.07 1.5-2.07-1.5Z" fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/><ellipse cx="9.7" cy="11" rx="1.05" ry="1.45" fill="#F3F3F3"/><ellipse cx="14.3" cy="11" rx="1.05" ry="1.45" fill="#F3F3F3"/><ellipse cx="12" cy="14.5" rx=".95" ry="1.2" fill="#F3F3F3"/></g></svg>',
  21: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><g transform="translate(-1.3 0)"><path d="M10 13a1 1 0 0 1 2 0 2 2 0 0 1-4 0 3 3 0 0 1 6 0 4.5 4.5 0 0 1-9 0 5.2 5.2 0 0 1 10.4 0"/><path d="M4.8 18.6h12.6c2 0 3.2-1.2 3.2-3.4v-2.8a1.6 1.6 0 0 0-3.2 0v3.8"/><path d="M18.2 10.9l-1-3.1M19.8 10.9l1-3.1" stroke-width="1.4"/><circle cx="17.2" cy="7.8" r=".95" fill="currentColor" stroke="none"/><circle cx="20.8" cy="7.8" r=".95" fill="currentColor" stroke="none"/></g></svg>',
  22: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="9" r="2.8"/><circle cx="16" cy="9" r="2.8"/><circle cx="8" cy="9.2" r="1.05" fill="currentColor" stroke="none"/><circle cx="16" cy="9.2" r="1.05" fill="currentColor" stroke="none"/><path d="M5.4 10.8C3.8 13 4.4 19 12 19s8.2-6 6.6-8.2"/><path d="M8 14.6q4 3 8 0"/></svg>',
  23: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11.4" cy="12.2" r="6.6"/><path d="M10.8 5.6c-.5-1.8.8-2.8 2.4-2.2"/><circle cx="13.8" cy="10.6" r="1.05" fill="currentColor" stroke="none"/><path d="M17.8 11.4 20.4 12.5 17.8 13.6Z" fill="currentColor"/><path d="M9.8 18.8v1.8M13 18.8v1.8"/></svg>',
  24: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><g transform="translate(0 .8)"><path d="M3.8 19h16.4"/><path d="M6 19a6 6 0 0 1 12 0"/><path d="M8.8 13.9C7.4 9.4 7.6 4.2 9.4 4.2s2.2 4.8 1.6 8.9"/><path d="M13 13.1c.2-3.5 1-6.5 3.4-7.5 2.2-.8 3.2 1 1.6 2.4-1.2 1-2.4 3-2.8 5.9"/><circle cx="10" cy="16.2" r="1" fill="currentColor" stroke="none"/><circle cx="14" cy="16.2" r="1" fill="currentColor" stroke="none"/></g></svg>',
  25: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.8 11q1.6 1.6 3.2 0M14 11q1.6 1.6 3.2 0"/><circle cx="12" cy="15.6" r="1.2"/><path d="M16.6 4.4h2.8l-2.8 3h2.8" stroke-width="1.5"/></svg>',
  26: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8.6" cy="10" r="1.15" fill="currentColor" stroke="none"/><path d="M13.8 10.6q1.6-1.8 3.2 0"/><path d="M8 14q4 3.4 8 0"/><path d="M12.6 15.9v1.3a1.6 1.6 0 0 0 3.2 0v-2" fill="currentColor"/></svg>',
  27: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 11.2C4 10.6 3.8 7.4 5.6 6c2-1.8 4.4-1.4 6.4-1.4s4.4-.4 6.4 1.4c1.8 1.4 1.6 4.6-.4 5.2V18q0 1.5-1.5 1.5h-9Q6 19.5 6 18Z"/><circle cx="9.8" cy="12.6" r="1" fill="currentColor" stroke="none"/><circle cx="14.2" cy="12.6" r="1" fill="currentColor" stroke="none"/><path d="M10.6 15.2q1.4 1.4 2.8 0"/></svg>',
  28: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 15V7a2 2 0 0 1 4 0v8"/><path d="M10 12.2H8.4a1.6 1.6 0 0 1-1.6-1.6V8.8M14 10.4h1.6a1.6 1.6 0 0 0 1.6-1.6V7.4"/><path d="M7 15h10l-1 4.6H8Z"/><circle cx="12" cy="3.7" r="1" fill="currentColor" stroke="none"/></svg>',
  29: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4.6c1.4 0 2.2.8 3 2.2l4.4 7.6c1.2 2.2.2 5-2.6 5H7.2c-2.8 0-3.8-2.8-2.6-5L9 6.8c.8-1.4 1.6-2.2 3-2.2Z"/><path d="M9.9 16.2h4.2v3.2H9.9Z" fill="currentColor"/><circle cx="10.1" cy="11.4" r=".95" fill="currentColor" stroke="none"/><circle cx="13.9" cy="11.4" r=".95" fill="currentColor" stroke="none"/><path d="M11.2 13.2q.8.9 1.6 0" stroke-width="1.4"/></svg>',
  30: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.8c-3.6 0-5.6 2.8-5.6 5.8 0 3.6 3 6.2 5.6 6.4 2.6-.2 5.6-2.8 5.6-6.4 0-3-2-5.8-5.6-5.8Z" fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/><path d="M11 16.9 12 15.7l1 1.2Z" fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/><path d="M9 8.4q.6-1.6 2-2" fill="none" stroke="#F3F3F3" stroke-width="1.4" stroke-linecap="round"/><path d="M12 17c-1.4 1 1.4 1.8 0 3.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
};
// a stored time zone (an id like America/Los_Angeles) in plain words, from the
// browser's own names: "Pacific Time, UTC−7", the offset being today's. a zone
// the browser cannot name shows as its id without underscores
function settingsZoneWords(zone){
  if (!zone) return "";
  try {
    const part = style => new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: style })
      .formatToParts(new Date()).find(x => x.type === "timeZoneName").value;
    const name = part("longGeneric");
    const off = /GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(part("longOffset"));
    const utc = off && off[1] && off[2] + off[3] !== "0000" ? "UTC" + (off[1] === "-" ? "−" : "+") + Number(off[2]) + (off[3] === "00" ? "" : ":" + off[3]) : "UTC";
    if (name.startsWith("GMT")) return utc;   // a zone the browser names only by its offset
    return name + ", " + utc;
  } catch (err) { return zone.replace(/_/g, " "); }
}
function settingsIcon(id){
  const mark = h("span", "sp-ico");
  mark.setAttribute("aria-hidden", "true");
  mark.innerHTML = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + SETTINGS_ICONS[id] + '</svg>';
  return mark;
}
function settingsMark(name){
  const svg = h("span");
  svg.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" ' +
    'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    SETTINGS_MARKS[name] + '</svg>';
  return svg.firstChild;
}

// the three window buttons a Mac window wears at its top left. the red one puts
// the page away, and its x shows while a pointer is over the group; the yellow
// and the green have nothing to do, since the page cannot be minimised or
// zoomed, so they are greyed out, carry no mark, and the keyboard skips them
const SETTINGS_LIGHTS = ["red", "yellow", "green"];
function settingsLights(close){
  const group = h("div", "sp-lights");
  for (const name of SETTINGS_LIGHTS){
    const light = h(name === "red" ? "button" : "span", "sp-light sp-" + name);
    if (name === "red"){
      light.type = "button";
      light.setAttribute("aria-label", "Close settings");
      light.addEventListener("click", close);
      light.innerHTML = '<svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" ' +
        'stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M3.75 3.75l4.5 4.5M8.25 3.75l-4.5 4.5"/></svg>';
    } else {
      light.setAttribute("role", "button");
      light.setAttribute("aria-disabled", "true");
      light.setAttribute("aria-label", name === "yellow" ? "Minimise" : "Maximise");
    }
    group.appendChild(light);
  }
  return group;
}

// fills root, which becomes the page, from source, the element holding the
// section groups. opts.close puts the whole page away. opts.lights, on the
// desktop, adds the window buttons that do it. opts.narrow, where the
// window is not what decides, is a query like matchMedia's that says when the
// page is narrow. opts.mac is the Mac's look, which the phone's drawer wears
// too: a mark beside each section's name, each section's choices in one rounded
// grey box, and no second heading over them. what comes back moves between the list and one section, and
// says where it stands
function settingsPage(root, source, opts){
  const narrow = opts.narrow || matchMedia(SETTINGS_NARROW);
  root.classList.add("qn-glass", "sp-page");
  if (opts.mac) root.classList.add("sp-mac");
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "Settings");

  const back = h("button", "sp-icon sp-back");
  back.type = "button";
  back.setAttribute("aria-label", "Back to settings");
  back.appendChild(settingsMark("back"));
  const title = h("h2", "sp-title", "Settings");
  const head = h("div", "sp-head");
  if (opts.lights) head.appendChild(settingsLights(() => opts.close()));
  head.append(back, title);

  const list = h("nav", "sp-list");
  list.setAttribute("aria-label", "Settings sections");
  const panes = h("div", "sp-panes");
  const sections = [...source.querySelectorAll(":scope > [data-section]")].map(group => {
    const id = group.dataset.section, label = group.dataset.label;
    const item = h("button", "sp-item");
    item.type = "button";
    item.dataset.section = id;
    if (opts.mac && SETTINGS_ICONS[id]) item.append(settingsIcon(id));
    item.append(h("span", "", label));
    const next = h("span", "sp-next");
    next.appendChild(settingsMark("next"));
    item.appendChild(next);
    const pane = h("section", "sp-pane");
    pane.id = "settings-" + id;
    pane.setAttribute("aria-label", label);
    if (opts.mac){
      const box = h("div", "sp-box");
      box.append(...group.childNodes);
      pane.appendChild(box);
    } else {
      pane.appendChild(h("h3", "sp-panehead", label));
      pane.append(...group.childNodes);
    }
    list.appendChild(item);
    panes.appendChild(pane);
    return { id, label, item, pane };
  });
  source.remove();
  const body = h("div", "sp-body");
  body.append(list, panes);
  root.replaceChildren(head, body);

  let current = sections[0], view = "list";
  function paint(){
    const detail = narrow.matches && view === "pane";
    root.dataset.view = view;
    root.toggleAttribute("data-narrow", narrow.matches);
    back.hidden = !detail;
    title.textContent = detail ? current.label : "Settings";
    for (const s of sections){
      const on = s === current;
      s.item.classList.toggle("on", on);
      s.pane.classList.toggle("on", on);
      if (on && !narrow.matches) s.item.setAttribute("aria-current", "true");
      else s.item.removeAttribute("aria-current");
    }
  }
  function show(id){
    const next = sections.find(s => s.id === id);
    if (!next) return;
    current = next;
    view = "pane";
    panes.scrollTop = 0;
    paint();
    if (narrow.matches) back.focus({ preventScroll: true });
  }
  function toList(){
    view = "list";
    paint();
    if (narrow.matches) current.item.focus({ preventScroll: true });
  }
  for (const s of sections) s.item.addEventListener("click", () => show(s.id));
  back.addEventListener("click", toList);
  if (typeof narrow.addEventListener === "function") narrow.addEventListener("change", paint);
  paint();
  return {
    show, list: toList, root,
    section: () => current.id,
    inDetail: () => narrow.matches && view === "pane",
    // it opens on the list; where the list is not alone, the section last seen shows beside it
    reset(){ view = "list"; panes.scrollTop = 0; paint(); },
    focus(){ current.item.focus({ preventScroll: true }); },
  };
}

// a query like matchMedia's, on the width of one element instead of the window
function widthQuery(el, limit){
  const heard = [];
  if (typeof ResizeObserver === "function") new ResizeObserver(() => heard.forEach(fn => fn())).observe(el);
  return {
    get matches(){ return el.getBoundingClientRect().width <= limit; },
    addEventListener(type, fn){ heard.push(fn); },
  };
}

// the desktop's seat for the page: a veil over the whole window, the same one
// the quick note opens over, with the page centred on it at about seven tenths
// of the window down and about half of it across, the veil and the page
// fading in and out together (.sp-veil in card-tokens.css). the page turns
// between its two layouts by its own width, not the window's. a press on the veil outside the page, Escape and the
// red window button all put the whole page away from either view, and no key
// goes on to the board it covers. opts carries onOpen and onClose for the page's
// own bookkeeping
function settingsOverlay(host, source, opts){
  const veil = h("div", "qn-veil sp-veil");
  veil.setAttribute("aria-hidden", "true");
  const seat = h("div");
  // a press on bare glass leaves focus on the page, so Escape still reaches the veil
  seat.tabIndex = -1;
  veil.appendChild(seat);
  host.appendChild(veil);
  let open = false, back = null, downOutside = false;
  const page = settingsPage(seat, source, { close, lights: true, mac: true, narrow: widthQuery(seat, SETTINGS_MAC_NARROW_PX) });
  function openOverlay(){
    if (open) return;
    open = true;
    back = document.activeElement;
    veil.classList.add("open");
    page.reset();
    veil.setAttribute("aria-hidden", "false");
    if (opts.onOpen) opts.onOpen();
    page.focus();
  }
  function close(){
    if (!open) return;
    open = false;
    veil.classList.remove("open");
    veil.setAttribute("aria-hidden", "true");
    if (opts.onClose) opts.onClose();
    const to = back;
    back = null;
    if (to && to.isConnected && typeof to.focus === "function") to.focus({ preventScroll: true });
    else if (seat.contains(document.activeElement)) document.activeElement.blur();
  }
  veil.addEventListener("keydown", e => {
    e.stopPropagation();
    if (e.key === "Escape" && !imeKey(e)){ e.preventDefault(); close(); }
  });
  // a press that starts and ends on the veil, outside the page, puts it away;
  // a selection dragged out of the page and let go on the veil does not
  veil.addEventListener("pointerdown", e => { downOutside = e.target === veil; });
  veil.addEventListener("click", e => {
    if (downOutside && e.target === veil) close();
    downOutside = false;
  });
  // and focus cannot wander onto the board behind it
  document.addEventListener("focusin", e => {
    if (open && !seat.contains(e.target)) page.focus();
  });
  return { open: openOverlay, close, isOpen: () => open, page, root: veil };
}

// ---- the feedback box -------------------------------------------------------
// Settings, Improvements holds a box to write feedback in, the same on the Mac
// board and the phone (the markup is each page's own, in its #setsrc). It works
// in four states, painted on the box as data-state:
//   locked     the profile has no name or no email: the box and the arrow are
//              greyed and cannot be used, and one grey line says why
//   idle       typing; the send arrow stands at the box's bottom right corner
//              while there is anything typed, as a card's typing box shows its own
//   counting   the arrow has turned into a cross with a round bar filling
//              around it; the person has FEEDBACK_WAIT_MS to press the cross,
//              which cancels with nothing sent and the words kept. the box
//              cannot be edited meanwhile, so what is sent is what was read
//   sending    the bar is full and the message is on its way
// A message that went empties the box; one that did not leaves the words and
// says so in one grey line. els holds box (the element that wears data-state),
// ta, send and note. opts.send(text) answers a promise of whether it went,
// opts.enter(e) says whether that key is the page's Enter-sends rule, and
// opts.ready is whether the profile has its name and email. A page that draws
// its own caret over the box (the Mac board's block) hands in opts.moved, called
// once the words have been changed from code: emptying the box fires no input,
// key or selection event, so that caret would stay where the sent words ended.
// The page's timer can be handed in as opts.wait (milliseconds) for the tests
const FEEDBACK_WAIT_MS = 3000;
const FEEDBACK_LINES = {
  locked: "Fill in your name and email in Profile to send feedback.",
  failed: "Did not send. Try again.",
  sent: "Sent. Thank you.",
};
function feedbackBox(els, opts){
  const wait = opts.wait == null ? FEEDBACK_WAIT_MS : opts.wait;
  let ready = !!opts.ready, state = "idle", line = "", timer = null, words = "";
  const typed = () => els.ta.value.trim() !== "";
  function paint(){
    els.box.dataset.state = ready ? state : "locked";
    els.box.style.setProperty("--fb-ms", wait + "ms");
    els.ta.disabled = !ready;
    els.ta.readOnly = state !== "idle";
    els.send.disabled = !ready || state === "sending";
    els.send.classList.toggle("show", state !== "idle" || typed());
    els.send.setAttribute("aria-label", state === "counting" ? "Cancel sending" : "Send feedback");
    els.note.textContent = ready ? line : FEEDBACK_LINES.locked;
  }
  function cancel(){
    if (state !== "counting") return;
    clearTimeout(timer);
    timer = null;
    state = "idle";
    paint();
  }
  function start(){
    if (!ready || state !== "idle" || !typed()) return;
    words = els.ta.value;
    line = "";
    state = "counting";
    timer = setTimeout(finish, wait);
    paint();
  }
  function finish(){
    timer = null;
    state = "sending";
    paint();
    Promise.resolve().then(() => opts.send(words)).then(went => went === true, () => false).then(went => {
      state = "idle";
      if (went){ els.ta.value = ""; line = FEEDBACK_LINES.sent; }
      else line = FEEDBACK_LINES.failed;
      paint();
      if (went && opts.moved) opts.moved();
    });
  }
  els.send.addEventListener("click", () => { if (state === "counting") cancel(); else start(); });
  els.ta.addEventListener("input", () => { line = ""; paint(); });
  els.ta.addEventListener("keydown", e => {
    if (!opts.enter(e)) return;
    e.preventDefault();
    if (!e.repeat) start();
  });
  paint();
  return {
    // the profile gained or lost its name or its email; losing one stops a send
    // that is counting down
    setReady(now){
      ready = !!now;
      if (!ready) cancel();
      paint();
    },
    cancel,
    state: () => (ready ? state : "locked"),
  };
}

// the feedback box on its own, for the Mac board's bar: the pill there opens a
// sheet in the middle of the window over the same dark veil as Settings, holding
// the box's row (its title, its grey line, the box and its one note line) and
// nothing else. there is only one box: the row is lifted out of Settings,
// Improvements into the sheet while it is open and set back after the fade out,
// so the words typed, a send counting down and the greyed state are the same in
// both places. a press on the veil outside the sheet and Escape put it away;
// closing never touches the words or a send already counting, whose timer is the
// box's own. opts carries onOpen and onClose for the page's own bookkeeping
function feedbackOverlay(host, row, opts){
  const veil = h("div", "qn-veil sp-veil fb-veil");
  veil.setAttribute("aria-hidden", "true");
  const sheet = h("div", "qn-glass sp-page sp-mac fb-sheet");
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  const title = row.querySelector(".setlabel span");
  sheet.setAttribute("aria-label", title ? title.textContent : "Share Feedback");
  // a press on bare glass leaves focus on the sheet, so Escape still reaches the veil
  sheet.tabIndex = -1;
  const pane = h("div", "sp-pane on");
  sheet.appendChild(pane);
  veil.appendChild(sheet);
  host.appendChild(veil);
  const seat = document.createComment("feedback");   // where the row stands in Settings
  row.before(seat);
  let open = false, back = null, downOutside = false, putBack = 0;
  function seatRow(){
    clearTimeout(putBack);
    putBack = 0;
    if (!open && row.parentNode !== seat.parentNode) seat.after(row);
  }
  function focusBox(){
    const ta = row.querySelector("textarea");
    (ta && !ta.disabled ? ta : sheet).focus({ preventScroll: true });
  }
  // for the page, once a greyed box has woken: the box takes the focus unless
  // something in the sheet already holds it
  function focusWoken(){
    const at = document.activeElement;
    if (open && (!at || at === sheet || !sheet.contains(at))) focusBox();
  }
  function openOverlay(){
    if (open) return;
    open = true;
    back = document.activeElement;
    clearTimeout(putBack);
    putBack = 0;
    pane.appendChild(row);
    veil.classList.add("open");
    veil.setAttribute("aria-hidden", "false");
    if (opts.onOpen) opts.onOpen();
    focusBox();
  }
  function close(){
    if (!open) return;
    open = false;
    veil.classList.remove("open");
    veil.setAttribute("aria-hidden", "true");
    if (opts.onClose) opts.onClose();
    const to = back;
    back = null;
    if (to && to.isConnected && typeof to.focus === "function") to.focus({ preventScroll: true });
    else if (sheet.contains(document.activeElement)) document.activeElement.blur();
    // the row stays in the sheet through the fade out, then goes home
    putBack = setTimeout(seatRow, 320);
  }
  veil.addEventListener("keydown", e => {
    e.stopPropagation();
    if (e.key === "Escape" && !imeKey(e)){ e.preventDefault(); close(); }
  });
  // a press that starts and ends on the veil, outside the sheet, puts it away;
  // a selection dragged out of the box and let go on the veil does not
  veil.addEventListener("pointerdown", e => { downOutside = e.target === veil; });
  veil.addEventListener("click", e => {
    if (downOutside && e.target === veil) close();
    downOutside = false;
  });
  // and focus cannot wander onto the board behind it
  document.addEventListener("focusin", e => {
    if (open && !sheet.contains(e.target)) focusBox();
  });
  return { open: openOverlay, close, isOpen: () => open, seat: seatRow, focus: focusWoken, root: veil };
}

// ---- a card's magic box -----------------------------------------------------
// what a card's agent put beside it (POST /magic), drawn the same on the board,
// where the box stands beside the card, and on the phone, where it comes down
// above the card the way the card list does. each page makes one view of its
// box element (.magicbox, with a bar .mbbar, at its top on the board and at its
// foot on the phone, and a body .mbbody), says where
// the box stands and how big, and asks the view what it shows wants (want, for
// MagicBox.place or MagicBox.fit, magic-box.js). hooks.placed is called when
// what it shows has a size it did not have, hooks.openSite(url) opens a site
// that will not be framed in a new page, and hooks.escape hears Escape typed
// in an agent's page. the bar holds the cross (.mbclose) and, at its other
// end, the green button that expands the box (.mbgrow, view.expand). the box
// shows what it holds and nothing else: its title is kept by the board and
// not drawn

// the mark for opening in a new page: a page with an arrow leaving it at the top
// right, drawn in the line's own colour
const MAGIC_NEW_PAGE = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 2.5h4v4"/>' +
  '<path d="M13.5 2.5 7.5 8.5"/><path d="M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3"/></svg>';
// the cross on the box's bar that puts it away: the card bar's own cross
// (.xbtn, two bars --bar-mark long and --cross-weight of that thick, with round
// ends, set across at 45 degrees), drawn on a 10 grid as one svg of --bar-mark:
// each stroke runs between 1.936 and 8.064, the bar's length less its thickness
// (10 - 1.3333), laid at 45 degrees about the middle
const MAGIC_CROSS = '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.3333" ' +
  'stroke-linecap="round" aria-hidden="true"><path d="M1.936 1.936L8.064 8.064M8.064 1.936L1.936 8.064"></path></svg>';
// the green button at the bar's other end, which expands the box over the
// board and puts it back: the Mac's own green window button's marks on the
// same 10 grid, in the same ink. two small triangles on the diagonal, their
// square corners out at the top left and the bottom right while the box is at
// its size (expand), and turned in to meet in the middle while it is expanded
// (reduce). their corners are rounded by a thin stroke of the same ink
const MAGIC_MARK = d => '<svg viewBox="0 0 10 10" fill="currentColor" stroke="currentColor" stroke-width=".6" ' +
  'stroke-linejoin="round" aria-hidden="true"><path d="' + d + '"></path></svg>';
const MAGIC_GROW = MAGIC_MARK("M1.8 1.8H6L1.8 6ZM8.2 8.2H4L8.2 4Z");
const MAGIC_SHRINK = MAGIC_MARK("M4.2 4.2H0.8L4.2 0.8ZM5.8 5.8H9.2L5.8 9.2Z");
// a site's name as the site gives it, or its address's host without "www."
function magicSiteName(box){
  const site = ((box.preview || {}).site || "").trim();
  let host = "";
  try { host = new URL(box.url || "").hostname; } catch (e) {}
  return (site && site !== host ? site : host.replace(/^www\./, "")) || site || box.url || "";
}
function magicView(el, hooks = {}){
  const view = { el, body: el.querySelector(".mbbody"), bar: el.querySelector(".mbbar"), url: "", natural: null, page: null };
  // the page guard finds the view by its box, for a click on a picture in it (magicBoxPicture)
  el._view = view;
  const placed = () => { if (hooks.placed) hooks.placed(); };
  const cross = el.querySelector(".mbclose");
  if (cross) cross.innerHTML = MAGIC_CROSS;
  const grow = el.querySelector(".mbgrow");
  if (grow) grow.innerHTML = MAGIC_GROW;
  // the words' two fuzzes, the ticket list's own (tickBands): how far they have
  // scrolled up, --upband, and how far they still can, --downband, in whole
  // pixels and capped at the box's --mb-fade. the bar stands at the box's top
  // on the board and at its foot on the phone, which puts it after the body
  // (m.html), and the words keep their lead on the bar's side: the lead's
  // worth of scroll there only closes that space and no word has gone under
  // the bar yet, so it is not counted. the far end's band counts all of it, as
  // the ticket list's do. a number is only written when it changes, and they
  // are read again whenever the box or the words change size, since either
  // moves how far the words can scroll without a scroll event
  const foot = !!view.bar && el.lastElementChild === view.bar;
  const bands = () => {
    const b = view.body, words = b.querySelector(".mbtext");
    if (view.fade == null) view.fade = parseFloat(getComputedStyle(el).getPropertyValue("--mb-fade")) || 0;
    if (view.lead == null && words) view.lead = parseFloat(getComputedStyle(words)[foot ? "paddingBottom" : "paddingTop"]) || 0;
    const lead = view.lead || 0;
    const up = Math.min(Math.max(0, Math.round(b.scrollTop - (foot ? 0 : lead))), view.fade);
    const down = Math.min(Math.max(0, Math.round(b.scrollHeight - b.clientHeight - b.scrollTop - (foot ? lead : 0))), view.fade);
    if (up !== view.up){ view.up = up; b.style.setProperty("--upband", up + "px"); }
    if (down !== view.down){ view.down = down; b.style.setProperty("--downband", down + "px"); }
  };
  view.body.addEventListener("scroll", bands, { passive: true });
  // the box changing size lets go of a zoom (zoomResized, below)
  const sized = typeof ResizeObserver === "function" ? new ResizeObserver(() => { bands(); zoomResized(); }) : null;
  if (sized) sized.observe(view.body);
  // expanded, the picture the box shows (.mbimg: an image box's own, or one
  // from its words shown alone, view.solo) zooms and moves where it stands, as
  // a card's picture does opened full screen (cardPictureLayer), on the same
  // numbers: a trackpad pinch (a wheel with ctrlKey, as Chrome sends it, or
  // Safari's gesture) or command and the wheel zoom about the pointer, from its
  // fitted size to four times that; two fingers pinch about their middle,
  // which carries it with them; zoomed, a dragged mouse, one finger or a
  // two-finger scroll moves it, never so far that an edge comes in past the
  // box's, so some of it always shows; a double click or a double tap goes
  // from fitted to twice at that point and back. a lone click or tap does
  // nothing, and never puts the box back. it is moved by a transform from its
  // top left corner (card-tokens.css), in the box's own pixels, the board's
  // stage scale counted out. a box on its way (hooks.moving) takes none of it,
  // so the click that expanded it is never the first of two
  const z = { img: null, to: null, at: null, grow: null, touch: null, drag: null, tapped: null, pinch: null };
  const zoomPic = () => view.big && !(hooks.moving && hooks.moving()) ? view.body.querySelector(":scope > .mbimg") : null;
  const zoomed = () => !!z.at && z.at.w > z.to.w + 0.5;
  // where the sheet fits it in the box (object-fit:scale-down): as large as
  // fits, never past its own size, and centred
  const zoomFit = img => {
    const W = img.offsetWidth, H = img.offsetHeight, w = img.naturalWidth || W, h = img.naturalHeight || H;
    const s = Math.min(W / w, H / h, 1);
    return { x: (W - w * s) / 2, y: (H - h * s) / 2, w: w * s, h: h * s, W, H };
  };
  const zoomStart = img => {
    if (z.img === img && z.to) return;
    zoomOff(false);
    Object.assign(z, { img, to: zoomFit(img) });
    z.at = z.to;
  };
  // a point on the screen in the picture's own pixels, and the screen's
  // pixels to its (s)
  const zoomPoint = (img, x, y) => {
    const r = view.body.getBoundingClientRect(), s = r.width / view.body.offsetWidth || 1;
    return { x: (x - r.left) / s - view.body.clientLeft - img.offsetLeft, y: (y - r.top) / s - view.body.clientTop - img.offsetTop, s };
  };
  // the motion of the moment run out at once, so a gesture starts from where it stands
  const zoomSettle = () => {
    if (!z.grow) return;
    z.grow.finish(); z.grow.cancel(); z.grow = null;
  };
  // across and down, a picture smaller than the box stands centred in it, and
  // a larger one never brings an edge in past the box's
  const zoomHeld = r => {
    const axis = (p, size, room) => size <= room ? (room - size) / 2 : Math.min(0, Math.max(room - size, p));
    return { x: axis(r.x, r.w, z.to.W), y: axis(r.y, r.h, z.to.H), w: r.w, h: r.h };
  };
  // the picture at r, there at once or, with glide, carried there from where
  // it stands on the picture's time and curve
  const zoomMove = (img, r, glide) => {
    const from = glide ? getComputedStyle(img).transform : null;
    if (z.grow){ z.grow.cancel(); z.grow = null; }
    z.at = zoomHeld(r);
    const k = z.at.w / z.to.w, on = k > 1 + 1e-6;
    img.style.transform = on ? "translate(" + (z.at.x - k * z.to.x) + "px, " + (z.at.y - k * z.to.y) + "px) scale(" + k + ")" : "";
    img.classList.toggle("zoomed", on);
    if (glide && !cardPictureStill(window))
      z.grow = img.animate([{ transform: from }, { transform: img.style.transform || "none" }], { duration: CARD_PICTURE_MS, easing: CARD_PICTURE_EASE });
  };
  // zoomed to k times its fitted size, its point under p kept there
  const zoomBy = (img, k, p, glide) => {
    const w = z.to.w * Math.min(CARD_PICTURE_ZOOM_MOST, Math.max(1, k)), f = w / z.at.w;
    zoomMove(img, { x: p.x - (p.x - z.at.x) * f, y: p.y - (p.y - z.at.y) * f, w, h: z.to.h * w / z.to.w }, glide);
  };
  // a click or a tap: the second of two close together takes it from fitted to
  // twice its size at that point, or back from any zoom
  const zoomTap = (img, x, y) => {
    const prior = z.tapped;
    z.tapped = null;
    if (prior && Date.now() - prior.t < CARD_PICTURE_DOUBLE_MS && Math.hypot(x - prior.x, y - prior.y) < CARD_PICTURE_DOUBLE_SLOP){
      zoomStart(img); zoomSettle();
      if (zoomed()) zoomMove(img, z.to, true);
      else zoomBy(img, CARD_PICTURE_ZOOM_TAP, zoomPoint(img, x, y), true);
      return;
    }
    z.tapped = { t: Date.now(), x, y };
  };
  // back to its fit and let go: at once, or with glide carried there from
  // where it stands, as the box shrinks on the same time and curve
  function zoomOff(glide){
    const img = z.img;
    if (!img) return;
    const from = z.grow ? getComputedStyle(img).transform : img.style.transform;
    if (z.grow){ z.grow.cancel(); z.grow = null; }
    Object.assign(z, { img: null, to: null, at: null, touch: null, drag: null, tapped: null, pinch: null });
    img.style.transform = "";
    img.classList.remove("zoomed", "dragging");
    if (glide && from && from !== "none" && !cardPictureStill(window))
      z.grow = img.animate([{ transform: from }, { transform: "none" }], { duration: CARD_PICTURE_MS, easing: CARD_PICTURE_EASE });
  }
  // the box laid out at another size, the window's or its own on the way
  // back, lets go of a zoom, as the full-screen picture does
  function zoomResized(){
    if (z.img && (z.img.offsetWidth !== z.to.W || z.img.offsetHeight !== z.to.H)) zoomOff(false);
  }
  const zoomOn = (type, fn) => view.body.addEventListener(type, e => {
    const img = zoomPic();
    if (img && e.target === img) fn(e, img);
  }, { passive: false });
  zoomOn("wheel", (e, img) => {
    zoomStart(img); zoomSettle();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1;
    if (e.ctrlKey || e.metaKey){
      e.preventDefault();
      const d = Math.max(-CARD_PICTURE_WHEEL_MOST, Math.min(CARD_PICTURE_WHEEL_MOST, e.deltaY * unit));
      zoomBy(img, z.at.w / z.to.w * Math.exp(-d * CARD_PICTURE_WHEEL_ZOOM), zoomPoint(img, e.clientX, e.clientY));
    } else if (zoomed()){
      e.preventDefault();
      const s = zoomPoint(img, 0, 0).s;
      zoomMove(img, { ...z.at, x: z.at.x - e.deltaX * unit / s, y: z.at.y - e.deltaY * unit / s });
    }
  });
  // Safari's pinch on a trackpad; the phone's fingers are read as touches
  zoomOn("gesturestart", (e, img) => {
    if (z.touch) return;
    e.preventDefault();
    zoomStart(img); zoomSettle();
    z.pinch = z.at.w / z.to.w;
  });
  zoomOn("gesturechange", (e, img) => {
    if (z.pinch == null) return;
    e.preventDefault();
    zoomBy(img, z.pinch * e.scale, zoomPoint(img, e.clientX, e.clientY));
  });
  zoomOn("gestureend", () => { z.pinch = null; });
  // the mouse: held down and dragged it moves a zoomed picture, picking no
  // words and dragging nothing out, and the click that ends a drag is not a
  // click on it
  zoomOn("pointerdown", (e, img) => {
    if (e.pointerType !== "mouse" || e.button) return;
    zoomStart(img); zoomSettle();
    z.drag = { start: { x: e.clientX, y: e.clientY }, last: { x: e.clientX, y: e.clientY }, moved: false };
    if (!zoomed()) return;
    try { img.setPointerCapture(e.pointerId); } catch (_) {}
    img.classList.add("dragging");
  });
  zoomOn("mousedown", e => { if (z.drag && zoomed()) e.preventDefault(); });
  zoomOn("dragstart", e => e.preventDefault());
  zoomOn("pointermove", (e, img) => {
    const d = z.drag;
    if (!d || e.pointerType !== "mouse") return;
    if (!(e.buttons & 1)){ z.drag = null; img.classList.remove("dragging"); return; }
    if (Math.hypot(e.clientX - d.start.x, e.clientY - d.start.y) > CARD_PICTURE_SLOP) d.moved = true;
    if (d.moved && zoomed()){
      const s = zoomPoint(img, 0, 0).s;
      zoomMove(img, { ...z.at, x: z.at.x + (e.clientX - d.last.x) / s, y: z.at.y + (e.clientY - d.last.y) / s });
    }
    d.last = { x: e.clientX, y: e.clientY };
  });
  for (const type of ["pointerup", "pointercancel"]) zoomOn(type, (e, img) => img.classList.remove("dragging"));
  zoomOn("click", (e, img) => {
    const dragged = z.drag?.moved;
    z.drag = null;
    if (!dragged) zoomTap(img, e.clientX, e.clientY);
  });
  // the fingers: two pinch about their middle, which carries the picture with
  // them; one moves a zoomed picture, and one put down and lifted without
  // moving, with no second joining it, is a tap. every touch on it is its own:
  // none scrolls or zooms the page, reaches the drawer behind or becomes a click
  const points = e => [...e.touches].map(t => ({ x: t.clientX, y: t.clientY }));
  const middle = p => ({ x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 });
  const zoomTouch = (type, fn) => zoomOn(type, (e, img) => { e.preventDefault(); e.stopPropagation(); zoomStart(img); fn(e, img); });
  zoomTouch("touchstart", (e, img) => {
    zoomSettle();
    const p = points(e);
    if (p.length >= 2){
      const m = middle(p);
      z.touch = { pinch: true, spread: Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y) || 1, mid: zoomPoint(img, m.x, m.y), from: z.at };
    } else if (p.length === 1) z.touch = { pinch: false, start: p[0], last: p[0], tap: !z.touch };
  });
  zoomTouch("touchmove", (e, img) => {
    const p = points(e), g = z.touch;
    if (!g) return;
    if (g.pinch && p.length >= 2){
      const m = middle(p), mid = zoomPoint(img, m.x, m.y);
      const k = g.from.w / z.to.w * Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y) / g.spread;
      const w = z.to.w * Math.min(CARD_PICTURE_ZOOM_MOST, Math.max(1, k)), f = w / g.from.w;
      zoomMove(img, { x: mid.x - (g.mid.x - g.from.x) * f, y: mid.y - (g.mid.y - g.from.y) * f, w, h: z.to.h * w / z.to.w });
    } else if (!g.pinch && p.length === 1){
      if (Math.hypot(p[0].x - g.start.x, p[0].y - g.start.y) > CARD_PICTURE_SLOP) g.tap = false;
      if (!g.tap && zoomed()){
        const s = zoomPoint(img, 0, 0).s;
        zoomMove(img, { ...z.at, x: z.at.x + (p[0].x - g.last.x) / s, y: z.at.y + (p[0].y - g.last.y) / s });
      }
      g.last = p[0];
    }
  });
  // the finger left of two goes on moving the picture from where it is
  const zoomLift = (e, img) => {
    const p = points(e), g = z.touch;
    if (p.length === 1){ z.touch = { pinch: false, start: p[0], last: p[0], tap: false }; return; }
    if (p.length) return;
    z.touch = null;
    if (g && !g.pinch && g.tap && e.type === "touchend") zoomTap(img, g.last.x, g.last.y);
  };
  zoomTouch("touchend", zoomLift);
  zoomTouch("touchcancel", zoomLift);
  // everything in it gone, so a frame that was showing stops running
  view.clear = () => {
    zoomOff(false);
    view.url = ""; view.page = null; view.natural = null; view.fade = null; view.lead = null; view.known = false;
    if (view.alone){ view.alone = null; view.body.classList.remove("alone"); }
    delete view.body.dataset.kind;
    view.body.textContent = "";
    bands();
  };
  // seen: a picture the page has already fetched and read, {src, natural}, so
  // the box is sized and shown at once rather than when the picture arrives
  view.draw = (box, seen) => {
    view.clear();
    view.url = box.kind === "url" ? box.url || "" : "";
    view.body.dataset.kind = box.kind;
    if (box.kind === "text" || box.kind === "markdown"){
      const prose = h("div", "mbtext cardmd" + (box.kind === "text" ? " plain" : ""));
      if (box.kind === "text") prose.textContent = box.text || "";
      else prose.innerHTML = fmt(box.text || "");
      view.body.appendChild(prose);
      if (sized) sized.observe(prose);
      bands();
    } else if (box.kind === "image"){
      // the board's own copy, served sandboxed, so the picture's site never
      // sees the owner's browser
      const img = h("img", "mbimg");
      img.alt = box.title || "";
      img.addEventListener("load", placed);
      img.src = seen && seen.src || box.src;
      view.body.appendChild(img);
      if (seen && seen.natural){ view.natural = seen.natural; view.known = true; return; }
      // the box takes the picture's own shape, read off a copy of it that is
      // never laid out: a drawing (SVG) on the page answers with the size it is
      // drawn at, which would hold the box at whatever size it last had. a
      // picture that cannot be read has no size of its own and takes the whole box
      const own = new Image();
      own.onload = own.onerror = () => {
        if (!img.isConnected) return;
        view.natural = [own.naturalWidth, own.naturalHeight];
        placed();
      };
      own.src = box.src;
    } else if (box.kind === "html"){
      page(box.html || "", 0);
    } else if (box.kind === "url" && box.shown === "frame"){
      const frame = h("iframe", "mbframe");
      frame.setAttribute("credentialless", "");
      frame.credentialless = true;
      frame.setAttribute("sandbox", MagicBox.SITE_SANDBOX);
      frame.setAttribute("referrerpolicy", "no-referrer");
      frame.src = box.url;
      view.body.append(frame, h("div", "mbcover"));
    } else if (box.kind === "url"){
      // a site that will not be framed: a smaller box in the middle with the
      // site's name and the mark for a new page, which opens it there
      const away = h("div", "mbaway"), open = h("button", "mbopen");
      const name = magicSiteName(box);
      open.type = "button";
      open.setAttribute("aria-label", "Open " + name + " in a new page");
      open.appendChild(h("span", "", name));
      open.insertAdjacentHTML("beforeend", MAGIC_NEW_PAGE);
      open.addEventListener("click", () => { if (view.url && hooks.openSite) hooks.openSite(view.url); });
      away.appendChild(open);
      view.body.appendChild(away);
    }
  };
  // an agent's page in its sealed frame. each time the page finishes loading it
  // says so with a word only it and the board know (MagicBox.pageDoc). a load
  // the word does not follow is the page sending its frame somewhere else,
  // which it may not: a fresh frame with the page takes its place, and a page
  // that keeps leaving is taken down after three tries. the frame cannot be
  // looked into, so the word is how the board knows what is in it
  const page = (html, tries) => {
    view.body.textContent = "";
    view.body.style.removeProperty("--mb-page");
    view.page = null;
    if (tries > 3) return;
    const frame = h("iframe", "mbframe");
    frame.setAttribute("sandbox", MagicBox.PAGE_SANDBOX);
    frame.setAttribute("referrerpolicy", "no-referrer");
    const run = view.page = { frame, word: "magic-" + Math.random().toString(36).slice(2), loads: 0, said: 0, tries, height: 0,
      seen: { top: 0, whole: 0, client: 0 }, sent: 0 };
    // a board that sizes the box to the page waits a moment for its height
    // (view.waiting), then shows it at whatever size it has
    if (hooks.sized) setTimeout(placed, PAGE_WAIT + 50);
    frame.addEventListener("load", () => {
      run.loads++;
      // the word is posted from the page's own load, so it lands a moment
      // after the frame's; half a second is long past it on a page that stayed
      setTimeout(() => {
        if (view.page === run && frame.isConnected && run.said < run.loads) page(html, tries + 1);
      }, 500);
    });
    frame.srcdoc = MagicBox.pageDoc(html, run.word, !!hooks.sized, !!hooks.tall);
    run.since = Date.now();
    view.body.append(frame, h("div", "mbcover"));
  };
  // hooks.sized: the page also says its own height, the word, a space and the
  // height in its pixels (MagicBox.pageDoc), and the box is sized to it.
  // hooks.heard(height, width) is told each height it says and the width it
  // was laid out at, and hooks.pageHeight(width) answers with a height already
  // known for the page at a width, which the box takes at once (view.want)
  const PAGE_WAIT = 1000;
  // hooks.tall: the page says its height and the box stays its own size: the
  // page is laid out that tall, --mb-page on the body (the phone's sheet), and
  // the box scrolls it as it scrolls words. a page whose height follows its
  // frame's (a full height in it) would grow for ever: once it has said three
  // heights in a row each the same way past the frame, the frame stays put
  const pageTall = run => {
    const over = run.height - run.frame.clientHeight;
    run.same = over > 0 && over === run.over ? (run.same || 0) + 1 : 0;
    run.over = over;
    if (run.same < 2) view.body.style.setProperty("--mb-page", run.height + "px");
  };
  addEventListener("message", e => {
    const run = view.page;
    if (!run || e.source !== run.frame.contentWindow || typeof e.data !== "string") return;
    if (e.data === run.word) run.said++;
    // control+option+left typed inside the page, which the board never hears
    // from a sealed frame: the page relays it (MagicBox.pageDoc)
    else if (hooks.back && e.data === run.word + " back") hooks.back();
    // and command+T, which the page stops so Chrome opens no tab
    else if (hooks.create && e.data === run.word + " create") hooks.create();
    // and Escape, which puts the expanded box back to its size
    else if (e.data === run.word + " escape"){ if (hooks.escape) hooks.escape(); }
    // where the page stands, for control+S (MagicBox.pageDoc, PAGE_SCROLL):
    // how far it has scrolled, how tall it is and how tall its window is, and
    // the last of the board's asks it has done. Where it stands is not taken
    // from a report older than the last ask, which the board has already moved on
    else if (hooks.sized && e.data.startsWith(run.word + " scroll ")){
      const [top, whole, client, done] = e.data.slice(run.word.length + 8).split(" ").map(Number);
      const seen = run.seen;
      if (seen && [top, whole, client, done].every(Number.isFinite)){
        seen.whole = whole; seen.client = client;
        if (done === run.sent) seen.top = top;
      }
    }
    // and the keys typed in the page, as a key the board would have heard, for
    // control+S to be followed in a page that holds the keys
    else if (hooks.key && hooks.sized && e.data.startsWith(run.word + " key ")){
      let said = null;
      try { said = JSON.parse(e.data.slice(run.word.length + 5)); } catch (_) {}
      if (Array.isArray(said) && said.length === 7){
        const [type, key, ctrlKey, shiftKey, metaKey, altKey, repeat] = said;
        hooks.key({ type: type === "up" ? "keyup" : "keydown", key: key === "s" || key === "S" || key === "Control" ? key : "",
          ctrlKey: ctrlKey === true, shiftKey: shiftKey === true, metaKey: metaKey === true, altKey: altKey === true,
          repeat: repeat === true, isComposing: false, defaultPrevented: false, target: document.body,
          preventDefault(){} });
      }
    }
    else if ((hooks.sized || hooks.tall) && e.data.startsWith(run.word + " ")){
      const tall = Math.ceil(+e.data.slice(run.word.length + 1));
      // a height said while the box is expanded is for that width alone, which
      // the box never takes beside its card, so it is not kept for it
      if (tall > 0 && hooks.heard && !view.big) hooks.heard(tall, run.frame.clientWidth);
      if (tall > 0 && tall !== run.height){
        run.height = tall;
        if (hooks.tall) pageTall(run);
        placed();
      }
    }
  });
  // an agent's page as something control+S can scroll, in the shape the board's
  // hold-to-scroll motion (responseScrollKey) takes of a response: what it
  // reads and writes is the page's, through the words it and the board
  // exchange (MagicBox.pageDoc, PAGE_SCROLL), and what it writes is only
  // asked of the page, which answers with where it then stands. The edge
  // bounce is the page's own, run on its root. One for each page the box
  // holds, so the motion ends when the page is another; null for what is not
  // an agent's page on a board that sizes the box to it (the phone's box lays
  // the page out as tall as it is and scrolls the box itself)
  view.pageScroller = () => {
    const run = view.page;
    if (!hooks.sized || !run || view.body.dataset.kind !== "html") return null;
    if (run.scroller) return run.scroller;
    const seen = run.seen;
    const post = text => { try { run.frame.contentWindow.postMessage(run.word + " " + text, "*"); } catch (_) {} };
    const part = { animate(frames, timing){ post("bounce " + JSON.stringify([frames, { duration: timing.duration }])); return { cancel(){} }; } };
    return run.scroller = { box: el, replyview: {
      get scrollTop(){ return seen.top; },
      set scrollTop(top){ seen.top = top; post("to " + top + " " + ++run.sent); },
      get scrollHeight(){ return seen.whole; },
      get clientHeight(){ return seen.client; },
      get isConnected(){ return run.frame.isConnected; },
      ownerDocument: el.ownerDocument,
      children: [part],
    } };
  };
  // what the box shows asks for (MagicBox's want), or nothing for a site, or a
  // page that has not said its height (hooks.sized), which take the whole room. room: the largest box there is room for,
  // which a page lays the words out at. scale: screen pixels to the page's own,
  // the board's stage scale. a picture asks for its own size, as many of the
  // page's pixels as it has pixels on screen, so it is never drawn past its
  // sharpness, with the bar as its head (at the foot on the phone); words for their own height at the
  // room's width; a site that will not be framed for a square. the edge, the
  // bar and the white kept at the far edge are added, so what is beside the
  // bar is the size it asks for. words a picture of theirs stands alone over
  // (view.solo) are measured as they stand without it, so the box keeps their
  // size and comes back to it
  view.want = (room, scale = 1) => {
    const alone = !!view.alone;
    if (alone) view.body.classList.remove("alone");
    try { return want(room, scale); } finally { if (alone) view.body.classList.add("alone"); }
  };
  const want = (room, scale) => {
    const air = getComputedStyle(view.body);
    const kind = view.body.dataset.kind, edges = el.offsetWidth - el.clientWidth,
      head = view.bar.offsetHeight + (parseFloat(air.marginTop) || 0) + (parseFloat(air.marginBottom) || 0);
    if (kind === "image"){
      const [w, h] = view.natural || [0, 0];
      return w && h ? { width: w / scale + edges, height: h / scale + edges, head } : null;
    }
    if (view.body.querySelector(".mbaway")) return { height: room.width };
    // an agent's page that has said its height, laid out at the box's width,
    // or whose height at that width is already known
    if (kind === "html"){
      const run = view.page;
      if (!hooks.sized || !run) return null;
      if (!run.height && hooks.pageHeight) run.height = hooks.pageHeight(room.width - edges) || 0;
      return run.height ? { height: run.height + edges + head } : null;
    }
    const words = view.body.querySelector(".mbtext");
    if (!words) return null;
    el.style.width = room.width + "px";
    return { height: words.offsetHeight + edges + head };
  };
  // a picture still on its way, or a page that has not yet said its height on
  // a board that sizes the box to it: the box is kept hidden, so it never
  // shows at the wrong size first. a picture whose size is already known
  // (seen) is shown at once. expanded, the box's size is not the page's, so a
  // page is never waited for
  view.waiting = () => {
    const run = view.page;
    if (hooks.sized && !view.big && run && view.body.dataset.kind === "html" && !run.height && Date.now() - run.since < PAGE_WAIT) return true;
    const img = view.body.dataset.kind === "image" && view.body.querySelector(".mbimg");
    return !!img && (!view.natural || !img.complete && !view.known);
  };
  // the box expanded over the board by its green button, or back at its own
  // size: where it then stands is each page's to say. the button's mark and
  // words turn with it. an agent's page the board sizes the box to
  // (hooks.sized) is laid out wider while the box is expanded and says its
  // height at that width: the height it had said at the box's own width is
  // kept, and is the box's again as it comes back, until the page says another.
  // a picture zoomed in it goes back to its fit, carried there as the box
  // shrinks, and expanded again it opens fitted
  view.big = false;
  view.expand = on => {
    on = !!on;
    if (on === view.big) return;
    view.big = on;
    zoomOff(!on);
    el.classList.toggle("big", on);
    if (grow){
      grow.innerHTML = on ? MAGIC_SHRINK : MAGIC_GROW;
      grow.setAttribute("aria-label", on ? "Reduce the magic box" : "Expand the magic box");
    }
    const run = view.page;
    if (!hooks.sized || !run) return;
    if (on) run.small = run.height;
    else if (run.small) run.height = run.small;
  };
  // a picture in the words shown alone (img), edge to edge in the body as an
  // image box shows its own (.mbimg), where it zooms the same way; the words
  // stay under it, hidden, at the scroll they had (.alone in card-tokens.css),
  // and have it again once it goes (null)
  view.alone = null;
  view.solo = img => {
    const b = view.body, words = b.querySelector(".mbtext");
    zoomOff(false);
    if (img && words){
      if (view.alone) view.alone.remove();
      else { view.wordsTop = b.scrollTop; b.classList.add("alone"); }
      const pic = view.alone = h("img", "mbimg");
      pic.alt = img.alt || ""; pic.draggable = false;
      pic.src = img.currentSrc || img.src;
      b.appendChild(pic);
    } else if (view.alone){
      view.alone.remove(); view.alone = null;
      b.classList.remove("alone");
      b.scrollTop = view.wordsTop || 0;
    }
    bands();
  };
  // a picture in the box clicked or tapped open (magicBoxPicture, the page
  // guard): the box expands to show it, a picture in the words alone, where it
  // zooms (hooks.expand, which says whether the box could expand); a box
  // already expanded shows it as it stands. false where the box cannot
  // expand, which is then left as it was
  view.picture = (img, back) => {
    if (!hooks.expand) return false;
    const words = !!img.closest(".mbtext"), was = view.alone;
    if (words) view.solo(img);
    if (view.big || hooks.expand(back)) return true;
    if (words && !was) view.solo(null);
    return false;
  };
  return view;
}

// ---- projects on the owner's servers -------------------------------------------------
// a project whose folder is on one of the owner's servers names that server
// (state.projects[i].server), and the board says for each server whether its
// link, which the server keeps connected out to the board, is up and whether
// it has gone unheard long enough that its projects fade (remote.servers[id]
// .faded, 30 seconds, so a short drop never flashes it). a server the board
// no longer knows has no link at all and fades at once
function remoteServerOf(state, owner){
  const p = ((state && state.projects) || []).find(x => x && x.id === owner);
  return p && p.server ? p.server : "";
}
// {server, name} while the project's server is faded, null otherwise
function remoteFaded(state, owner){
  const sid = remoteServerOf(state, owner);
  if (!sid) return null;
  const s = ((state.remote || {}).servers || {})[sid];
  return s && !s.faded ? null : { server: sid, name: (s && s.name) || sid };
}
// the project a folder the picker chose already is, or null: the same path on
// the same machine, so a server's /home/you/app is never a folder of this Mac
function folderProject(state, folder){
  if (!state || !folder) return null;
  const sid = folder.machine && folder.machine !== "this" ? folder.machine : "";
  return allRowsOf(state).find(ow => (state.pwds || {})[ow] === folder.path && remoteServerOf(state, ow) === sid) || null;
}
// the route that makes a project of a folder the picker chose: a server's
// folder names its machine, and the board reads the folder there before it
// keeps the project. a folder on this Mac asks exactly as it always did
function projectRoute(folder){
  const server = folder.machine && folder.machine !== "this" ? folder.machine : "";
  return "/project?name=" + encodeURIComponent(folder.name || "project") +
    (server ? "&machine=" + encodeURIComponent(server) : "");
}
// a refused folder in plain words: a server answers in plain words already
// (its link down, its folder outside its home), this Mac's by projectRefusal
function folderRefusal(pr, state, folder){
  if (folder.machine && folder.machine !== "this" && pr && pr.error && pr.error !== "duplicate project") return pr.error;
  return projectRefusal(pr, state, folder.name);
}
// the folder a project row shows: a server's project as the server's name and
// its path there, name:/path
function lanePlace(state, owner){
  const dir = (state.pwds || {})[owner] || "";
  const sid = remoteServerOf(state, owner);
  if (!sid) return dir;
  const s = ((state.remote || {}).servers || {})[sid];
  return ((s && s.name) || sid) + ":" + dir;
}
// the fade over the project on screen, the same on the board and the phone: the
// body's remotedown class, which each page's sheet dims the project by, and one
// line saying why. none of it takes the pointer, so the composer still takes
// typing and sending; what is sent waits on the Mac until the link is back
function showRemoteFade(faded){
  document.body.classList.toggle("remotedown", !!faded);
  let note = document.getElementById("remotenote");
  if (!faded){
    if (note) note.hidden = true;
    return;
  }
  if (!note){
    note = document.createElement("div");
    note.id = "remotenote";
    note.setAttribute("role", "status");
    document.body.appendChild(note);
  }
  const words = faded.name + " is not connected. What you send waits here and reaches the agent when the link is back.";
  if (note.textContent !== words) note.textContent = words;
  note.hidden = false;
}

// ---- searching the cards ---------------------------------------------------------
// the Mac board's search (the magnifier in its bar, index.html) asks the board's
// GET /search as the words are typed and draws what it answers. what it works
// out on the way is here, so it can be checked without a page: the route, the
// matched words of a snippet and a title, the groups, and the search itself.
// the phone does not search yet
const SEARCH_PAUSE = 150;   // ms the field is left alone before it searches
const SEARCH_LIMIT = 20;    // cards one search shows at most
const SEARCH_WORD = /[\p{L}\p{M}\p{N}_]+/gu;   // a word, as the board's index reads one
// the section names a result is shown with: the board's own four, under both
// the names the search answers with and the names the ticket list keeps
const SEARCH_SECTIONS = { todo: "Doing", doing: "Doing", docked: "Docked", deferred: "Deferred", done: "Done" };
function searchSectionName(section){ return SEARCH_SECTIONS[section] || ""; }
// whether what is typed holds a word to search for. the board answers a query
// with no word in it with every card, which a search box never means
function searchHasWords(q){ return /[\p{L}\p{N}_]/u.test(String(q || "")); }
// what one search asks: the last word may be the start of a longer one, since
// the field searches while it is typed into, and a project's own window
// searches its own project alone
function searchRoute(q, lane){
  return "/search?q=" + encodeURIComponent(String(q || "").trim()) + "&prefix=1&limit=" + SEARCH_LIMIT +
    (lane ? "&lane=" + encodeURIComponent(lane) : "");
}
// a text as its runs of plain and marked words, each [start, end] of marks in
// the page's own string units. the runs are set as text, so nothing the board
// answers is ever read as markup. marks out of order or over each other are
// put right, and any past the text's end are cut there
function searchSplit(text, marks){
  text = String(text || "");
  const spans = (Array.isArray(marks) ? marks : [])
    .filter(m => Array.isArray(m) && Number.isInteger(m[0]) && Number.isInteger(m[1]))
    .map(([a, b]) => [Math.max(0, Math.min(a, text.length)), Math.max(0, Math.min(b, text.length))])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  const out = [];
  let at = 0;
  for (const [a, b] of spans){
    const start = Math.max(a, at);
    if (b <= start) continue;
    if (start > at) out.push({ text: text.slice(at, start), mark: false });
    const last = out[out.length - 1];
    if (start === at && last && last.mark) last.text += text.slice(start, b);
    else out.push({ text: text.slice(start, b), mark: true });
    at = b;
  }
  if (at < text.length) out.push({ text: text.slice(at), mark: false });
  return out;
}
// the board counts a snippet's marks in characters, as Python does, where the
// page counts its strings in UTF-16 units: a character past the basic plane,
// an emoji say, is one there and two here. so each mark is moved onto the
// page's own count before the snippet is cut
function searchPieces(snippet, marks){
  const text = String(snippet || ""), units = [0];
  for (const ch of text) units.push(units[units.length - 1] + ch.length);
  const unit = n => units[Math.max(0, Math.min(n, units.length - 1))];
  return searchSplit(text, (Array.isArray(marks) ? marks : [])
    .filter(m => Array.isArray(m) && Number.isInteger(m[0]) && Number.isInteger(m[1]))
    .map(([a, b]) => [unit(a), unit(b)]));
}
// the title is not always the piece of the card the board matched, so its own
// words are marked here: each word that starts with a word typed, the way the
// board marks a snippet, and each word the board marked in the snippet, which
// catches the other forms of a word it matches ("searching" finds "search")
function searchTitlePieces(title, q, snippetPieces){
  const text = String(title || "");
  const typed = [...new Set((String(q || "").toLowerCase().match(SEARCH_WORD) || []))];
  const seen = new Set((snippetPieces || []).filter(p => p.mark).map(p => p.text.toLowerCase()));
  const marks = [];
  for (const m of text.matchAll(SEARCH_WORD)){
    const word = m[0].toLowerCase();
    if (seen.has(word) || typed.some(t => word.startsWith(t))) marks.push([m.index, m.index + m[0].length]);
  }
  return searchSplit(text, marks);
}
// the cards found, in a group for each project. the groups come in the order
// their best card does, so the first card shown is still the board's best;
// rows is every card in the order they are shown, which the arrows walk
function searchGroups(results){
  const groups = [], byLane = new Map();
  for (const r of Array.isArray(results) ? results : []){
    if (!r || typeof r.card !== "string") continue;
    let group = byLane.get(r.lane);
    if (!group){ group = { lane: r.lane, rows: [] }; byLane.set(r.lane, group); groups.push(group); }
    group.rows.push(r);
  }
  return { groups, rows: groups.flatMap(g => g.rows) };
}
// what the panel says when the board could not search, in plain words
function searchTrouble(status, body){
  if (status === 404) return "Search starts working once the board restarts";
  if (status === 503) return "Search is not running on this board";
  const error = body && typeof body.error === "string" ? body.error : "";
  if (status === 400 && error) return error[0].toUpperCase() + error.slice(1);
  return "The board did not answer. Try again in a moment";
}
// the search the panel holds, apart from its drawing: what is typed, what is on
// show and the card picked. typing only ever sets a timer, so the field never
// waits for the board; the search goes once the field has been left alone for
// SEARCH_PAUSE, a newer search cancels an older one still out, and an answer
// that comes back after the words changed is dropped, so a slow answer never
// stands over a newer one. until the new answer lands the last one stays on
// show, so the list does not flash empty between keys.
//   phase   empty (nothing to search for), results, none (no card matches) or
//           trouble (note says why)
//   hot     the place of the picked card in rows, the first on every answer
// ask(url, signal) is the page's fetch and answers {status, body}; changed is
// told after every change to what is on show
function cardSearch({ ask, lane = null, later = setTimeout, cancel = clearTimeout, changed = () => {} }){
  const s = { q: "", phase: "empty", groups: [], rows: [], hot: -1, note: "", building: false, waiting: false };
  let turn = 0, timer = 0, out = null, onLand = null;
  const halt = () => {
    cancel(timer);
    timer = 0;
    onLand = null;
    if (out){ out.abort(); out = null; }
  };
  const clear = () => Object.assign(s, { phase: "empty", groups: [], rows: [], hot: -1, note: "", building: false, waiting: false });
  async function run(mine){
    timer = 0;
    const control = typeof AbortController === "function" ? new AbortController() : null;
    out = control;
    let status = 0, body = null;
    try { ({ status, body } = await ask(searchRoute(s.q, lane), control ? control.signal : undefined)); }
    catch (err){ if (err && err.name === "AbortError") return; }
    if (mine !== turn) return;   // typed over while it was out
    out = null;
    s.waiting = false;
    if (status === 200 && body && Array.isArray(body.results)){
      const found = searchGroups(body.results);
      Object.assign(s, { groups: found.groups, rows: found.rows, phase: found.rows.length ? "results" : "none",
        hot: found.rows.length ? 0 : -1, note: "", building: !!body.index && body.index.ready === false });
    } else {
      Object.assign(s, { groups: [], rows: [], phase: "trouble", hot: -1, note: searchTrouble(status, body), building: false });
    }
    changed(s);
    const told = onLand;
    onLand = null;
    if (told) told(s.picked());
  }
  s.type = q => {
    s.q = String(q == null ? "" : q);
    halt();
    const mine = ++turn;
    if (!searchHasWords(s.q)){ clear(); changed(s); return; }
    s.waiting = true;
    timer = later(() => run(mine), SEARCH_PAUSE);
  };
  // the arrows: one card down or up, stopping at either end, as Spotlight does
  s.move = step => {
    if (!s.rows.length) return;
    const to = Math.max(0, Math.min(s.rows.length - 1, s.hot + step));
    if (to !== s.hot){ s.hot = to; changed(s); }
  };
  // the pointer moving over a card picks it
  s.point = at => {
    if (at >= 0 && at < s.rows.length && at !== s.hot){ s.hot = at; changed(s); }
  };
  s.picked = () => s.rows[s.hot] || null;
  // Enter: told the picked card at once, or, while the words typed have not
  // been searched yet, once they have. a search still waiting out its pause
  // goes now, and the first card it finds is the one picked
  s.settle = told => {
    if (!s.waiting){ told(s.picked()); return; }
    onLand = told;
    if (timer){ cancel(timer); timer = 0; run(turn); }
  };
  // the panel shut: nothing more goes out, and what was typed and found stays
  s.halt = () => { halt(); turn++; s.waiting = false; };
  return s;
}
