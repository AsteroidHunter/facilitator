# Third-Party Notices

`cm-markdown.js` is a prebuilt bundle of the CodeMirror 6 editor, built
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

## Lucide icons

The navigator's file-type icons are Lucide, the chosen set for now; they are easy
to swap later. Update or remove this notice if the icons change.

`index.html` embeds five file-type icons from Lucide as inline static SVG path
data (the `MD_ICONS` constant): `folder`, `file-text`, `file-code`, `image` and
`file`. No package is installed and nothing is fetched at runtime; only the exact
path geometry is copied in. The icons were taken from Lucide release `1.47.0`,
commit `3b9ea6d08707edc439f25a4c354cb0d6b8bee973`, at
`https://github.com/lucide-icons/lucide`. None of the five belong to Lucide's
Feather-derived subset, so all are covered by the ISC License below.

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
