# Swapping the squid logo

The source is `app/assets/facilitator_logo_blank_v0.3.png` (2400 x 2400, transparent). It is kept as the source and is never served. Every logo the app shows is a file cut from it.

## Where the logo shows

| Where | Served from | Size in pixels |
|---|---|---|
| Mac home lockup | PNG inlined in `index.html` (`#npmark`) | 192 x 192 |
| Phone home lockup | the same PNG, read out of the board page by `m.html` | 192 x 192 |
| Phone sign-in lockup | PNG inlined in `m-gate.html` | 192 x 192 |
| Onboarding welcome card | `/m-splash-squid.png` | 640 x 640 |
| Mac settings button | `/m-splash-squid.png`, cut by CSS | 640 x 640 |
| Phone launch picture (`m-splash.js`, kept by `m-sw.js`) | `/m-splash-squid.png` | 640 x 640 |
| Phone settings button | PNG inlined in `m.html` | 123 x 120 |
| Home-screen icon (`apple-touch-icon`) | `/m-icon-180.png` | 180 x 180 |
| Favicon link and both manifests | `/m-icon-192.png` | 192 x 192 |
| Both manifests, large icon | `/m-icon-512.png` | 512 x 512 |
| Top of the main README | `app/tools/readme-header/facilitator-header.svg` | vector |

## How each file is made

- Crop to the squid, resize, and save lossless. No palette reduction, no recoloring.
- The splash and the 192 lockup are square windows centered on the squid, sized so the squid is 0.893 of the picture's height (the share the first splash had), so the drawn height in every lockup stays the same. The window may pass the source's edges, which are transparent.
- The phone settings button is the squid's exact bounds, resized.
- The icons keep their background (252, 251, 249) and padding, with the squid centered.

## Cuts that follow the squid's bounds

Find the new bounds: the first and last rows and columns with alpha above 2. Stray faint pixels (alpha 1 and 2) can reach the corners of the source, so a plain "any alpha" test returns the whole file. Then recompute:

- `.squidmark` in `index.html` and `onboarding.html`: the aspect ratio, the image width, and the negative margins, all as percentages of the box.
- `#dock .squidmark` in `m.html`: the aspect ratio, and the comment above it.
- `.obbrand .squidmark` in `onboarding.html` keeps the old box width (917 / 1126) on purpose, so the word and version do not move; the picture inside is the full square, centered, at 111.99% of the box height. It only changes if the window share above changes.

## The phone's cache key

The cache key is the name the phone app saves its copy of the home logo under. Bump it so phones fetch the new logo. It is `BRAND_KEY` in `app/m.html` (now `homebrand.squid05`).

## The README banner

After changing the logo in `m-gate.html`, run this from the top of the repo:

```
python3 app/tools/readme-header/generate.py
```

## Tests

From `app/`, run each file with `node --test tests/<name>.test.cjs`:

- `phone-inline-squid` pins the source's bounds (alpha above 2) and the phone button.
- `phone-files-gzip`, `phone-worker-page-code`, `onboarding`.
- `phone-row-browser` and `settings-page-browser` pin the aspect ratios and open a browser.
- `phone-home` pins the cache key, though some of its checks already fail.
