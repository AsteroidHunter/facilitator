# Third-Party Notices

`app/cm-markdown.js` is a prebuilt bundle of the CodeMirror 6 editor, built
outside this repository from the packages listed below. Each is distributed
under the MIT License, whose text and copyright notices follow.

## Bundled packages

| Package | Version |
| --- | --- |
| @codemirror/state | 6.7.1 |
| @codemirror/view | 6.43.9 |
| @codemirror/commands | 6.11.0 |
| @codemirror/language | 6.12.4 |
| @codemirror/lang-markdown | 6.5.2 |
| @codemirror/search | 6.7.1 |
| @codemirror/autocomplete | 6.20.3 |
| codemirror | 6.0.2 |
| codemirror-live-markdown | 0.5.1-alpha.1 |

## Copyright notices

- CodeMirror (`@codemirror/*` and `codemirror`): Copyright (C) 2018 by Marijn
  Haverbeke and others.
- `codemirror-live-markdown`: Copyright (C) the codemirror-live-markdown
  authors.

## MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## d3-force

`app/graph-force.js` holds the published UMD builds of four d3 packages,
unchanged, which the graph of the links between cards (`app/graph.js`) lays
its cards out with. Nothing is fetched at runtime. The builds were taken from
each package's `dist/` folder as published on npm.

| Package | Version |
| --- | --- |
| d3-dispatch | 3.0.1 |
| d3-quadtree | 3.0.1 |
| d3-timer | 3.0.1 |
| d3-force | 3.0.0 |

Source: `https://github.com/d3/d3-force` and the other three under
`https://github.com/d3`. All four are distributed under the ISC License,
with the same text:

### ISC License (d3)

Copyright 2010-2021 Mike Bostock

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.

## Lucide icons

The navigator's file-type icons are Lucide, the chosen set for now; they are easy
to swap later. Update or remove this notice if the icons change.

`app/index.html` embeds five file-type icons from Lucide as inline static SVG path
data (the `FILENAV_ICONS` constant): `folder`, `file-text`, `file-code`, `image` and
`file`. No package is installed and nothing is fetched at runtime; only the exact
path geometry is copied in. The icons were taken from Lucide release `1.47.0`,
commit `3b9ea6d08707edc439f25a4c354cb0d6b8bee973`, at
`https://github.com/lucide-icons/lucide`. None of the five belong to Lucide's
Feather-derived subset, so all are covered by the ISC License below.

The Mac board's top bar also draws Lucide's `bug` (the feedback button, the
`#feedbackbtn` button in `app/index.html`) as inline static SVG path data, its
geometry unchanged, at 15px with a 2 stroke like the bar's other icons. It was
copied from the `icons/bug.svg` on Lucide's main branch on 2026-10-15, and it is
not part of Feather's set either, so it is covered by the same ISC License.

The token chart's download button draws Lucide's `download`, `loader-circle` and
`check` the same way (inline static SVG path data, geometry unchanged, 14px with a
2 stroke), covered by the same ISC License.

### ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

## Feather icons

The attach button's paperclip is Feather's `paperclip`. `app/index.html`,
`app/m.html`, `app/onboarding.html` and `app/m-gate.html` embed its path as
inline static SVG path data (the `CLIP_ICON` constant, and the gate page's
sample typing box); the geometry is unchanged, drawn at 17px with a 1.9 stroke.
No package is installed and nothing is fetched at runtime. Source:
`https://github.com/feathericons/feather`.

Feather is distributed under the MIT License, whose text is given above, with
this copyright notice: Copyright (c) 2013-2017 Cole Bemis.

## Inter

The chart picture the home page saves (`app/home-widgets.js`) carries the latin
subset of Inter, the variable font (weights 100 to 900), as the `INTER_LATIN`
constant, a base64 WOFF2 file taken unchanged from Google Fonts (version 20,
`https://fonts.google.com/specimen/Inter`), so the name and the repo link on the
picture are drawn in Inter without the network. Inter is Copyright (c) 2016 The
Inter Project Authors (`https://github.com/rsms/inter`) and is licensed under the
SIL Open Font License, Version 1.1, `https://openfontlicense.org`.
