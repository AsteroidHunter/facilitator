/* The phone's own launch image, painted for the device that is asking. Shared
   by the board page (m.html) and the sign-in page (m-gate.html), because iOS
   takes the picture from whichever page the icon is added from, keeps it in
   the icon for good, and since the sign-in page came in front of /m that page
   is where every new icon is added.

   Nothing here reads the board. It needs the screen, the squid picture (a
   public file) and a canvas, so it runs the same before sign-in as after.
   Each page decides when to call installStartupImage(SPLASH_LOGO). */

// --- the phone's own launch image (iOS) ---
// An installed web app on iOS shows a launch image only through
// <link rel="apple-touch-startup-image">, and each tag's media query has to
// match the device's exact pixel size, so there is no fixed set of files that
// covers every iPhone and the picture is painted for THIS device at runtime.
// Android builds its splash from the manifest and every other browser ignores
// these tags, so the work only happens where it does something.
const SPLASH_LOGO = "/m-splash-squid.png";
const SPLASH_BG = "#ffffff";
// the logo's longer side spans this fraction of the screen's SHORTER edge; its
// other side and its centred position follow from the file's own aspect ratio
const SPLASH_LOGO_FRACTION = 0.32;
// the credit line under it. both numbers are fractions of that same shorter
// edge, so the line grows and shrinks with the screen exactly as the logo does
const SPLASH_HANDLE = "@theonetrueakash";
const SPLASH_HANDLE_FRACTION = 0.035;        // font size / shorter edge
const SPLASH_HANDLE_BOTTOM_FRACTION = 0.12;  // bottom edge -> the text's middle
// a quiet credit, not a label: apple's systemGray2
const SPLASH_HANDLE_COLOR = "#aeaeb2";
// Tried in order against a real 2D context, best first. A context runs the font
// shorthand through the CSS parser and drops the WHOLE declaration if any part
// of it fails to parse, leaving the context on its previous font, so a stack a
// browser dislikes does not degrade: it silently paints the line in the canvas
// default at the wrong size. Every name is a system face, so there is nothing
// to load and the canvas can draw the moment it is asked to.
const SPLASH_FONT_LADDER = [
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif',
  "system-ui",
  "sans-serif",
];

// pure: screen + dpr + logo aspect -> the exact device-pixel canvas, the centred
// logo rect, the credit line's size and anchor, and the device-matching media
// query. no DOM and no canvas, so it can be checked on its own
function splashLayout(inp){
  const canvasW = Math.round(inp.screenW * inp.dpr);
  const canvasH = Math.round(inp.screenH * inp.dpr);
  const shortEdge = Math.min(canvasW, canvasH);
  const box = shortEdge * SPLASH_LOGO_FRACTION;    // the logo's bounding square
  // contain-fit the ratio inside that square: the longer side lands on the box
  const logoW = inp.logoAspect >= 1 ? box : box * inp.logoAspect;
  const logoH = inp.logoAspect >= 1 ? box / inp.logoAspect : box;
  const orientation = inp.screenW <= inp.screenH ? "portrait" : "landscape";
  return {
    canvasW, canvasH,
    screenW: inp.screenW, screenH: inp.screenH,
    logoX: (canvasW - logoW) / 2, logoY: (canvasH - logoH) / 2, logoW, logoH,
    // whole device pixels for the type size, unlike the logo's rect: this canvas
    // is rasterized once at exactly these pixels and never resampled
    handleFont: Math.round(shortEdge * SPLASH_HANDLE_FRACTION),
    handleCenterX: canvasW / 2,
    handleCenterY: canvasH - shortEdge * SPLASH_HANDLE_BOTTOM_FRACTION,
    media: "(device-width: " + inp.screenW + "px) and (device-height: " + inp.screenH + "px) " +
           "and (-webkit-device-pixel-ratio: " + inp.dpr + ") and (orientation: " + orientation + ")",
  };
}

// the launch image's credit line restated in the SCREEN's own CSS pixels. only
// the vertical axis converts: the canvas centres the text on canvasW/2, so the
// horizontal answer is "the middle" and needs no number. the ratio is the
// canvas-to-screen one rather than a bare 1/dpr, since the canvas is rounded to
// whole device pixels and that can leave the two axes a hair apart
function splashHandleBox(g, screenH){
  const sy = (screenH === undefined ? g.screenH : screenH) / g.canvasH;
  const fontPx = g.handleFont * sy;
  return { top: g.handleCenterY * sy - fontPx / 2, height: fontPx, fontPx };
}

// put the credit line's font on a 2D context and hand back what the context
// actually holds afterwards. each rung is assigned and then read back, and the
// size coming back is the proof the shorthand parsed at all. the size is read as
// a NUMBER rather than looked for as a piece of the string, because the size
// asked for is a repeating fraction on most screens and comes back rounded
function applySplashFont(ctx, px){
  for (const family of SPLASH_FONT_LADDER){
    ctx.font = px + "px " + family;
    const back = /(\d+(?:\.\d+)?)px/.exec(ctx.font);
    if (back && Math.abs(Number(back[1]) - px) < 0.05) break;
  }
  return ctx.font;
}

// THE CREDIT LINE IS ASKED FOR IN SCREEN PIXELS, NOT THE CANVAS'S.
// Everything else on this canvas is a rectangle, and a rectangle drawn at three
// times the size and shown at a third of it is the same picture. Type is not:
// the system face carries a tracking table, so the same string at the same
// proportion of the screen is measurably wider per em at a small size than at a
// large one. The line is therefore asked for at the size it occupies on the
// SCREEN and the canvas is scaled to put it on the device pixels the launch
// image needs. "middle" is the point CSS puts at the middle of a line box.
function drawSplashHandle(ctx, text, fontPx, sx, sy, deviceX, deviceY){
  ctx.save();
  ctx.scale(1 / sx, 1 / sy);
  applySplashFont(ctx, fontPx);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = SPLASH_HANDLE_COLOR;
  ctx.fillText(text, deviceX * sx, deviceY * sy);
  ctx.restore();
}

// paint solid white, then the logo centred, then the credit line near the bottom
function paintSplash(ctx, logo, g){
  ctx.fillStyle = SPLASH_BG;
  ctx.fillRect(0, 0, g.canvasW, g.canvasH);
  ctx.drawImage(logo, g.logoX, g.logoY, g.logoW, g.logoH);
  drawSplashHandle(ctx, SPLASH_HANDLE, splashHandleBox(g).fontPx,
                   g.screenW / g.canvasW, g.screenH / g.canvasH,
                   g.handleCenterX, g.handleCenterY);
}

// iOS (including iPadOS, which reports as a Mac but has a touch screen) or an
// already-installed window: the only places these tags do anything. the
// installed test is the board page's own isInstalledWindow, written out here
// because the sign-in page has none of that page's script
function isAppleHomeScreenTarget(nav){
  const ua = nav.userAgent;
  const iOS = /iP(hone|od|ad)/.test(ua) || (/Macintosh/.test(ua) && nav.maxTouchPoints > 1);
  const installed = nav.standalone === true ||
    (typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches);
  return iOS || installed;
}
let splashStarted = false;
// Paint this device's launch image once per load and inject its link. Safe to
// call at boot: it does nothing off iOS and nothing after the first call, and it
// swallows its own errors, since a launch image is cosmetic and must never break
// a start. A missing or unreadable file simply leaves the phone with whatever it
// had before, which is its plain white default.
function installStartupImage(src){
  if (splashStarted) return;
  splashStarted = true;
  try {
    if (!document.head || !isAppleHomeScreenTarget(navigator)) return;
    const img = new Image();
    img.onload = () => {
      try {
        const layout = splashLayout({
          screenW: screen.width, screenH: screen.height,
          dpr: window.devicePixelRatio || 1,
          logoAspect: img.naturalWidth / img.naturalHeight || 1,
        });
        const canvas = document.createElement("canvas");
        canvas.width = layout.canvasW; canvas.height = layout.canvasH;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        paintSplash(ctx, img, layout);
        const link = document.createElement("link");
        link.rel = "apple-touch-startup-image";
        link.media = layout.media;
        link.href = canvas.toDataURL("image/png");
        document.head.appendChild(link);
      } catch (e) {}
    };
    img.src = src;
  } catch (e) {}
}
