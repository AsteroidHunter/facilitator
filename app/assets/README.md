# Swapping the squid logo

The source is `app/assets/facilitator_logo_blank_v0.3.png` (2139 x 2096, transparent, with a small empty margin). It is kept as the source and is never served. Every logo the app shows is a file cut from it.

## Where the logo shows

| Where | Served from | Size in pixels |
|---|---|---|
| Mac home lockup | PNG inlined in `index.html` (`#npmark`) | 192 x 192 |
| Phone home lockup | the same PNG, read out of the board page by `m.html` | 192 x 192 |
| Phone sign-in and install page lockup (the page the phone link shows before sign-in, served by `bridge_gate.py`) | PNG inlined in `m-gate.html` | 192 x 192 |
| Onboarding welcome card | `/m-splash-squid.png` | 640 x 640 |
| Mac settings button | `/m-splash-squid.png`, cut by CSS | 640 x 640 |
| Phone launch picture (`m-splash.js`, kept by `m-sw.js`) | `/m-splash-squid.png` | 640 x 640 |
| Phone settings button | PNG inlined in `m.html` | 123 x 120 |
| Home-screen icon (`apple-touch-icon`) | `/m-icon-180.png` | 180 x 180 |
| Favicon link and both manifests | `/m-icon-192.png` | 192 x 192 |
| Both manifests, large icon | `/m-icon-512.png` | 512 x 512 |
| Top of the main README | `app/tools/readme-header/facilitator-header.svg` | vector |

Nowhere else: the Mac pages' favicon is empty (`data:,`), the phone's startup curtain is a globe, and `install.sh`, `uninstall.sh`, the CLI and `qr.py` print no logo.

## How each file is made

Every copy is cut by one script, run from the top of the repo (standard library only, about ten seconds):

```
python3 app/tools/squid-logo/build_logo.py
```

It rewrites the three icons, the splash, and the inline PNGs in `index.html`, `m-gate.html` and `m.html`. Then run `generate.py` for the banner (see below).

- The source is pixel art, but its blocks are not on one regular grid (uneven spacings, a slightly tilted head tip), so there is no block size to snap to. A smooth resize (Lanczos or area average) leaves every edge pixel a blend of the orange and the background, a pale peach rim that reads as yellow beside the orange. So the copies are never resized smoothly.
- Each output pixel is decided from the source pixels whose centres fall inside it: ink if at least half of them have alpha 128 or more, otherwise background. An ink pixel takes the palette colour most of those pixels are closest to. The palette is orange (255, 156, 46), black (0, 0, 0) and the eye shine (255, 247, 176). So a file holds the background and those three flat colours only, and no edge pixel is a blend.
- The lockups, splash and button have a transparent background. Their transparent pixels carry the orange colour (alpha 0), so a viewer that scales without premultiplying cannot pull a dark edge in.
- The splash and the 192 lockup are square windows centered on the squid, sized so the squid is 0.893 of the picture's height (the share the first splash had), so the drawn height in every lockup stays the same. The window may pass the source's edges, which are transparent.
- The phone settings button is the squid's exact bounds, resized.
- The icons keep their background (252, 251, 249), with the squid's solid extent centered and drawn at the width it had before: 156, 166 and 442 pixels for 180, 192 and 512. Icons are opaque RGB; the rest are RGBA.
- A drawn size can differ from a smooth resize by a pixel or two. Check the squid's bounds in a rebuilt file before changing a CSS cut.
- The page's own CSS draws the 192 lockups at 32 to 64 pixels, so a browser still smooths those on screen.
## Cuts that follow the squid's bounds

Find the new bounds: the first and last rows and columns with alpha above 2. Stray faint pixels (alpha 1 and 2) can reach the corners of the source, so a plain "any alpha" test returns the whole file. Then recompute:

- `.squidmark` in `index.html` and `onboarding.html`: the aspect ratio, the image width, and the negative margins, all as percentages of the box.
- `#dock .squidmark` in `m.html`: the aspect ratio, and the comment above it.
- `.obbrand .squidmark` in `onboarding.html` keeps the old box width (917 / 1126) on purpose, so the word and version do not move; the picture inside is the full square, centered, at 111.99% of the box height. It only changes if the window share above changes.

## The phone's cache key

The cache key is the name the phone app saves its copy of the home logo under. Bump it so phones fetch the new logo. It is `BRAND_KEY` in `app/m.html` (now `homebrand.squid07`).

The phone's worker (`m-sw.js`) keeps a copy of `/m-splash-squid.png`, but asks the board first and replaces its copy on every answer, so its cache name does not need to change for a new squid.

## The README banner

After changing the logo in `m-gate.html`, run this from the top of the repo:

```
python3 app/tools/readme-header/generate.py
```

The `readme-header` workflow in `.github/workflows` also regenerates it on GitHub.

## After the swap: what a running board serves

The board reads every page and picture from disk on each request, so a swap shows as soon as the files land in the folder the board runs from. Up to v0.2.425 the sign-in page was the exception: `bridge_gate.py` read `m-gate.html` (and the version) once when the board started and served that copy until a restart, so a phone saw the old squid and the old version on the sign-in page while everything else was new. From v0.2.426 it is read on each answer; a board still running older code needs one `facilitator restart` to pick that up.

Check what the board actually serves with GET requests only, and compare the bytes with the files:

- on the board's port (8877): `/`, `/m`, `/onboarding`, `/manifest.json`, `/m-manifest.json`, `/m-icon-180.png`, `/m-icon-192.png`, `/m-icon-512.png`, `/m-splash-squid.png`
- on the phone link's port (8878), with no cookie: `/m` and `/` (the sign-in page; its inline PNG must equal the one in `m-gate.html`), and the same icons, manifest and splash

## What the repo cannot change

- An iPhone keeps the home-screen icon and launch picture it was added with. To see the new ones, remove the icon and add it again from the sign-in page.
- An installed Mac app (Chrome's Install app) keeps the icon it was installed with until Chrome next checks the manifest and takes the new icons; reinstalling takes them at once.

## Tests

From `app/`, run each file with `node --test tests/<name>.test.cjs`:

- `phone-inline-squid` pins the source's bounds (alpha above 2) and the phone button.
- `phone-files-gzip`, `phone-worker-page-code`, `onboarding`.
- `bridge-gate-page-fresh` checks that the sign-in page follows `m-gate.html` and the version without a restart.
- `phone-row-browser` and `settings-page-browser` pin the aspect ratios and open a browser.
- `phone-home` pins the cache key, though some of its checks already fail.
