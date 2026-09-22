# README header banner

`generate.py` renders the banner at the top of the repository README: the same
logo/name/version lockup the PWA installation guide page shows (the `.identity`
block in `m-gate.html`). It shows only those three elements, on a transparent
background, with no panel, border, rounding, shadow, or scenery.

Everything is lifted from the product source, so the banner cannot drift:

- **logo**: the data-URI PNG on the installation header's `.identity img` in
  `m-gate.html`, drawn in a square box with contain semantics, as that page does.
- **name**: the text of `.name` in `m-gate.html`.
- **version**: the text of `#npversion` in `index.html`. This is the app's single
  version source of truth (see `RUNBOOK.md`), the same string `bridge_gate.py`
  reads to fill the gate's version label, so there is never a second version
  string to maintain.

Style matches the installation header (tokens from `card-tokens.css`): the name
is Inter weight 650 in ink `#211D17`, the version is IBM Plex Mono in sub
`#75695A` directly below it, and the relative sizes and spacing keep the header's
64:22:12 logo:name:version proportion with a 12/4 gap.

## Output

One static SVG in this folder: `facilitator-header.svg`.

The background is transparent, so the lockup sits directly on the README. A
`prefers-color-scheme` media query lightens only the ink colours for dark hosts;
the background stays transparent and the geometry is unchanged. The SVG is
self-contained: no scripts and no external references, with the logo carried
inside it as a data URI, so it is meant to be shown through a plain `<img>`.
Static image hosts differ in what they render, so confirm the result where it
will be published. Text stays as `<text>` in the Inter and IBM Plex Mono stacks;
a viewer without those fonts falls back to the platform sans and mono, so the
banner still reads.

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

`.github/workflows/readme-header.yml` re-runs this on push when `index.html`
(the version), `m-gate.html` (the logo and header styling), the generator, or the
workflow itself changes, and commits the refreshed SVG on the same branch. It
re-fetches the branch head and re-renders from it before each non-force push, so
the committed banner always matches the newest source, and it commits only when
the banner actually changed. It is branch-relative: each branch keeps its own
banner for the version on that branch. This becomes live only once the workflow
and generator are pushed to the host. It does not bump the semantic version and
does not force the host's image cache to refresh instantly.

## Referencing the image

Image paths are relative to the README containing them. A README at the
repository root uses `tools/readme-header/facilitator-header.svg`. Adjust that
prefix if the document is moved.
