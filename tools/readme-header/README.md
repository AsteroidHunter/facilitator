# README header banner

`generate.py` renders the banner at the top of the repository README: a rounded
warm-paper panel carrying the app's own first-open logo/name/version lockup. It
shows only that lockup's three elements (logo, name, version), with no
background scenery.

Everything is lifted from `index.html`, so the banner cannot drift from the app:

- **logo**: the embedded data-URI PNG on `#npmark`, reused as-is (the same mark
  the PWA header shows), so there is no second logo file to keep in step.
- **name**: the text of `#npbrandname`.
- **version**: the text of `#npversion`. This is the app's single version source
  of truth (see `RUNBOOK.md`), the same string `bridge_gate.py` reads for the
  phone gate, so there is never a second version string to maintain.

Palette and font come from `card-tokens.css` (paper `#F5F4F1`, ink `#211D17`,
sub `#75695A`, the Inter stack).

## Output

One static SVG in this folder: `facilitator-header.svg`.

The panel is an opaque warm-paper rectangle with rounded corners, so it reads the
same on a light or dark README and needs no light/dark split. The SVG is
self-contained: no scripts and no external references, with the logo carried
inside it as a data URI, so it is meant to be shown through a plain `<img>`.
Static image hosts differ in what they render, so confirm the result where it
will be published. Text stays as `<text>` in the Inter / `-apple-system` stack; a
viewer without Inter falls back to the platform sans, so the banner still reads.

## Run it

No dependencies beyond the standard library:

```
python tools/readme-header/generate.py
```

Output is deterministic, so re-running without a source change rewrites identical
bytes.

`--version vX.Y.Z` is a test-only override that renders a different version
string WITHOUT touching `index.html`, so a fixture can prove the version flows
through to the SVG. `--repo-root` and `--out-dir` are also available for tests.

## Automatic refresh

`.github/workflows/readme-header.yml` re-runs this on push when `index.html`, the
generator, or the workflow itself changes, and commits the refreshed SVG on the
same branch. It re-fetches the branch head and re-renders from it before each
non-force push, so the committed banner always matches the newest source, and it
commits only when the banner actually changed. It is branch-relative: each branch
keeps its own banner for the version on that branch. This becomes live only once
the workflow and generator are pushed to GitHub. It does not bump the semantic
version and does not force GitHub's image cache to refresh instantly.

## Referencing the image

Image paths are relative to the README containing them. A README at the
repository root uses `tools/readme-header/facilitator-header.svg`. Adjust that
prefix if the document is moved.
