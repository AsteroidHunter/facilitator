/*
 * The card views share this deliberately small Markdown renderer. It accepts
 * only the syntax the card UI promises, escapes every other byte, and keeps all
 * URL policy in safeLinkTarget and safeImageTarget. Nothing from card text is
 * ever copied into an HTML attribute without passing through escapeAttribute.
 */
(function installCardMarkdown(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CardMarkdown = api;
})(typeof globalThis === "object" ? globalThis : this, function cardMarkdownFactory() {
  "use strict";

  const COPY_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
  const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const MAX_BLOCK_DEPTH = 32;

  const ATTACHMENT_TYPES = Object.freeze({
    png: ["image", "image/png"], jpg: ["image", "image/jpeg"], jpeg: ["image", "image/jpeg"],
    gif: ["image", "image/gif"], webp: ["image", "image/webp"], svg: ["image", "image/svg+xml"],
    mp4: ["video", "video/mp4"], m4v: ["video", "video/x-m4v"], mov: ["video", "video/quicktime"],
    webm: ["video", "video/webm"], ogv: ["video", "video/ogg"],
    mp3: ["audio", "audio/mpeg"], m4a: ["audio", "audio/mp4"], aac: ["audio", "audio/aac"],
    wav: ["audio", "audio/wav"], ogg: ["audio", "audio/ogg"], oga: ["audio", "audio/ogg"],
    opus: ["audio", "audio/ogg"], weba: ["audio", "audio/webm"],
    pdf: ["document", "application/pdf"], doc: ["document", "application/msword"],
    docx: ["document", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  });
  const ATTACHMENT_ACCEPT = Object.keys(ATTACHMENT_TYPES).map(ext => "." + ext).join(",") +
    "," + [...new Set(Object.values(ATTACHMENT_TYPES).map(info => info[1]))].join(",");
  const MAX_ATTACHMENT_SIZE = 100 * 1024 * 1024;

  function attachmentInfo(name) {
    const ext = /\.([a-z0-9]+)$/i.exec(String(name))?.[1].toLowerCase();
    const info = Object.hasOwn(ATTACHMENT_TYPES, ext) ? ATTACHMENT_TYPES[ext] : null;
    return info ? { ext, kind: info[0], type: info[1] } : null;
  }

  function attachmentFile(file) {
    let name = file.name || "attachment";
    let info = attachmentInfo(name);
    // Clipboard files sometimes have a MIME type but no extension.
    if (!info && !/\.[^.]+$/.test(name)) {
      const type = ({ "audio/x-wav": "audio/wav", "audio/x-m4a": "audio/mp4" })[file.type] || file.type;
      const ext = Object.keys(ATTACHMENT_TYPES).find(ext => ATTACHMENT_TYPES[ext][1] === type);
      if (ext) { name += "." + ext; info = attachmentInfo(name); }
    }
    const error = !info ? "Unsupported file type. Choose an image, video, audio, PDF or Word file." :
      file.size > MAX_ATTACHMENT_SIZE ? "File is too large. The limit is 100 MiB per file." :
      file.size === 0 ? "The file is empty." : "";
    return { ...info, name, error };
  }

  function escapeHTML(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, ch => ESCAPES[ch]);
  }

  // Kept separate by name so every attribute construction is easy to audit.
  function escapeAttribute(value) {
    return escapeHTML(value);
  }

  function unwrapTarget(raw) {
    let value = String(raw == null ? "" : raw).trim();
    if (value.startsWith("<") && value.endsWith(">")) value = value.slice(1, -1).trim();
    return value;
  }

  function safeLinkTarget(raw) {
    const value = unwrapTarget(raw);
    if (!value || /[\u0000-\u001f\u007f\\]/.test(value)) return null;
    if (value[0] === "#" && !/\s/.test(value)) return value;
    try {
      if (/^https?:\/\//i.test(value)) {
        const parsed = new URL(value);
        return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
      }
      if (/^\/(?!\/)/.test(value)) {
        const base = new URL("http://facilitator.invalid/");
        const parsed = new URL(value, base);
        if (parsed.origin !== base.origin) return null;
        return parsed.pathname + parsed.search + parsed.hash;
      }
    } catch (_) {}
    return null;
  }

  // Cards have always auto-rendered only files uploaded to this Facilitator.
  // Markdown images keep that boundary. Remote, data, and traversal targets are
  // left as text, which also means the renderer never makes a third-party fetch.
  function safeImageTarget(raw) {
    const value = unwrapTarget(raw);
    if (!value || /[\u0000-\u001f\u007f\\]/.test(value)) return null;
    try {
      const base = new URL("http://facilitator.invalid/");
      const parsed = new URL(value, base);
      if (parsed.origin !== base.origin || !parsed.pathname.startsWith("/uploads/") ||
          parsed.pathname === "/uploads/") return null;
      return parsed.pathname + parsed.search + parsed.hash;
    } catch (_) {
      return null;
    }
  }

  function renderAttachment(raw, alt = "", imageSyntax = false) {
    const target = safeImageTarget(raw);
    if (!target) return escapeHTML(raw);
    let name;
    try { name = decodeURIComponent(target.split(/[?#]/)[0].split("/").pop()); }
    catch (_) { name = target.split(/[?#]/)[0].split("/").pop(); }
    const info = attachmentInfo(name);
    const href = escapeAttribute(target);
    if (info?.kind === "image" || (!info && imageSyntax)) return '<img class="shot" src="' + href + '" alt="' + escapeAttribute(alt) + '">';
    const label = escapeHTML(name.replace(/^\d{13,19}-/, ""));
    if (!info) return '<a href="' + href + '" target="_blank" rel="noopener">' + label + '</a>';
    const download = new URL(target, "http://facilitator.invalid");
    download.searchParams.set("download", "1");
    const links = '<span class="attachment-links"><a href="' + href + '" target="_blank" rel="noopener">Open</a> ' +
      '<a href="' + escapeAttribute(download.pathname + download.search) + '" download>Download</a></span>';
    const media = info.kind === "audio" || info.kind === "video"
      ? '<' + info.kind + ' controls preload="metadata"' + (info.kind === "video" ? ' playsinline' : '') +
        ' src="' + href + '"></' + info.kind + '>' : '';
    return '<span class="attachment attachment-' + info.kind + '">' + media +
      '<span class="attachment-name">' + label + '</span>' + links + '</span>';
  }

  // Build all bracket and parenthesis relationships once per inline run. A
  // failed [label](target) must be constant-time at each byte; rescanning the
  // remaining string for every unmatched [ made malformed input quadratic.
  function inlineStructure(text) {
    const escaped = new Uint8Array(text.length);
    let slashes = 0;
    for (let i = 0; i < text.length; i++) {
      escaped[i] = slashes % 2;
      slashes = text[i] === "\\" ? slashes + 1 : 0;
    }

    const nextBracket = new Int32Array(text.length + 1);
    nextBracket.fill(-1);
    let nearest = -1;
    for (let i = text.length - 1; i >= 0; i--) {
      if (text[i] === "]" && !escaped[i]) nearest = i;
      nextBracket[i] = nearest;
    }

    const parenClose = new Int32Array(text.length);
    parenClose.fill(-1);
    const stack = [];
    for (let i = 0; i < text.length; i++) {
      if (escaped[i]) continue;
      if (text[i] === "(") stack.push(i);
      else if (text[i] === ")" && stack.length) parenClose[stack.pop()] = i;
    }
    return { escaped, nextBracket, parenClose };
  }

  function closingDelimiter(text, delimiter, from, structure) {
    let at = text.indexOf(delimiter, from);
    while (at >= 0) {
      if (!structure.escaped[at] && text.slice(from, at).trim()) return at;
      at = text.indexOf(delimiter, at + delimiter.length);
    }
    return -1;
  }

  function bracketTarget(text, start, image, structure) {
    const labelStart = start + (image ? 2 : 1);
    const close = structure.nextBracket[labelStart];
    if (close < 0 || text[close + 1] !== "(" || structure.escaped[close + 1]) return null;
    const end = structure.parenClose[close + 1];
    if (end < 0) return null;
    return {
      label: text.slice(labelStart, close),
      target: text.slice(close + 2, end),
      end: end + 1,
      raw: text.slice(start, end + 1),
    };
  }

  function trimBareEnd(raw) {
    const counts = { "(": 0, ")": 0, "[": 0, "]": 0, "{": 0, "}": 0 };
    for (const ch of raw) if (Object.hasOwn(counts, ch)) counts[ch]++;
    let end = raw.length;
    while (end) {
      if (/[.,;:!?"'\u2019\u201d]/.test(raw[end - 1])) {
        end--;
        continue;
      }
      const close = raw[end - 1];
      const open = close === ")" ? "(" : close === "]" ? "[" : close === "}" ? "{" : "";
      // A wrapper contributes an unmatched closer because its opener sits just
      // before the URL token. Counts are updated as closers are removed, which
      // keeps a long run of trailing parentheses linear.
      if (open && counts[close] > counts[open]) {
        counts[close]--;
        end--;
        continue;
      }
      break;
    }
    return { value: raw.slice(0, end), trailing: raw.slice(end) };
  }

  function inlineBoundary(text, at) {
    return at === 0 || /[\s(\[{<"'\u2018\u201c]/.test(text[at - 1]);
  }

  function bareToken(text, start) {
    let end = start;
    while (end < text.length && !/[\s<>]/.test(text[end])) end++;
    const raw = text.slice(start, end);
    const trimmed = trimBareEnd(raw);
    return { ...trimmed, end: end - trimmed.trailing.length };
  }

  function plainAlt(label) {
    return label.replace(/\\([\\`*_[\]{}()#+\-.!~|])/g, "$1").replace(/[`*_~]/g, "");
  }

  function renderInline(source, depth) {
    const text = String(source == null ? "" : source);
    if ((depth || 0) > 12) return escapeHTML(text);
    const structure = inlineStructure(text);
    let html = "";
    let i = 0;
    while (i < text.length) {
      if (text[i] === "\\" && i + 1 < text.length && /[\\`*_[\]{}()#+\-.!~|]/.test(text[i + 1])) {
        html += escapeHTML(text[i + 1]);
        i += 2;
        continue;
      }

      if (text[i] === "`") {
        let run = 1;
        while (text[i + run] === "`") run++;
        const delimiter = "`".repeat(run);
        const close = text.indexOf(delimiter, i + run);
        if (close >= 0) {
          html += '<code class="inlinecode">' + escapeHTML(text.slice(i + run, close)) + "</code>";
          i = close + run;
          continue;
        }
      }

      const image = text.startsWith("![", i) ? bracketTarget(text, i, true, structure) : null;
      if (image) {
        const target = safeImageTarget(image.target);
        html += target ? renderAttachment(target, plainAlt(image.label), true) : escapeHTML(image.raw);
        i = image.end;
        continue;
      }

      const link = text[i] === "[" ? bracketTarget(text, i, false, structure) : null;
      if (link) {
        const target = safeLinkTarget(link.target);
        html += target
          ? '<a href="' + escapeAttribute(target) + '" target="_blank" rel="noopener">' +
            renderInline(link.label, (depth || 0) + 1) + "</a>"
          : escapeHTML(link.raw);
        i = link.end;
        continue;
      }

      if (inlineBoundary(text, i) && /^https?:\/\//i.test(text.slice(i))) {
        const token = bareToken(text, i);
        const target = safeLinkTarget(token.value);
        if (target) {
          html += '<a href="' + escapeAttribute(target) + '" target="_blank" rel="noopener">' +
                  escapeHTML(token.value) + "</a>";
          i = token.end;
          continue;
        }
      }

      if (inlineBoundary(text, i) && text.startsWith("/uploads/", i)) {
        const token = bareToken(text, i);
        const target = safeImageTarget(token.value);
        if (target) {
          html += renderAttachment(target);
          i = token.end;
          continue;
        }
      }

      // Emphasis and strong together. The closing run has to be read whole:
      // taking its first two markers as the strong close leaves the third
      // standing in the middle of the words, which is what "***alpha***" used
      // to render as. Nothing new is accepted here that was not accepted
      // before; the run is only cut in the right place. A triple with no
      // closing triple falls through to the pair below exactly as it did.
      const both = text.startsWith("***", i) ? "***" : text.startsWith("___", i) ? "___" : null;
      if (both) {
        const close = closingDelimiter(text, both, i + 3, structure);
        if (close >= 0) {
          html += "<em><b>" + renderInline(text.slice(i + 3, close), (depth || 0) + 1) + "</b></em>";
          i = close + 3;
          continue;
        }
      }

      const strong = text.startsWith("**", i) ? "**" : text.startsWith("__", i) ? "__" : null;
      if (strong) {
        const close = closingDelimiter(text, strong, i + 2, structure);
        if (close >= 0) {
          html += "<b>" + renderInline(text.slice(i + 2, close), (depth || 0) + 1) + "</b>";
          i = close + 2;
          continue;
        }
      }

      if (text.startsWith("~~", i)) {
        const close = closingDelimiter(text, "~~", i + 2, structure);
        if (close >= 0) {
          html += "<del>" + renderInline(text.slice(i + 2, close), (depth || 0) + 1) + "</del>";
          i = close + 2;
          continue;
        }
      }

      if (text[i] === "*" || text[i] === "_") {
        const marker = text[i];
        const wordUnderscore = marker === "_" && i > 0 && /[\p{L}\p{N}]/u.test(text[i - 1]);
        const close = wordUnderscore ? -1 : closingDelimiter(text, marker, i + 1, structure);
        if (close >= 0 && !(marker === "_" && /[\p{L}\p{N}]/u.test(text[close + 1] || ""))) {
          html += "<em>" + renderInline(text.slice(i + 1, close), (depth || 0) + 1) + "</em>";
          i = close + 1;
          continue;
        }
      }

      html += escapeHTML(text[i]);
      i++;
    }
    return html;
  }

  function fenceStart(line) {
    return /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  }

  function headingStart(line) {
    const match = /^ {0,3}(#{1,6})(.*)$/.exec(line);
    if (!match || (match[2] && !/^[\t ]/.test(match[2]))) return null;
    let text = match[2].replace(/^[\t ]+/, "");
    // Closing hashes count as syntax only when whitespace separates them from
    // content. Thus "# C#" keeps the language name while "# C #" closes it.
    text = /^#+[\t ]*$/.test(text) ? "" :
      text.replace(/[\t ]+#+[\t ]*$/, "").replace(/[\t ]+$/, "");
    return { level: match[1].length, text };
  }

  function horizontalRule(line) {
    const compact = line.trim().replace(/\s/g, "");
    return compact.length >= 3 && (/^-+$/.test(compact) || /^\*+$/.test(compact) || /^_+$/.test(compact));
  }

  function indentWidth(value) {
    let width = 0;
    for (const ch of value) width += ch === "\t" ? 4 - (width % 4) : 1;
    return width;
  }

  function leadingWidth(line) {
    return indentWidth((/^[\t ]*/.exec(line) || [""])[0]);
  }

  function removeIndent(line, wanted) {
    let width = 0;
    let at = 0;
    while (at < line.length && width < wanted && (line[at] === " " || line[at] === "\t")) {
      width += line[at] === "\t" ? 4 - (width % 4) : 1;
      at++;
    }
    return line.slice(at);
  }

  function listStart(line) {
    const match = /^([\t ]*)([-+*]|\d+[.)])([\t ]+)(.*)$/.exec(line);
    if (!match) return null;
    const indent = indentWidth(match[1]);
    return {
      indent,
      ordered: /^\d/.test(match[2]),
      start: /^\d/.test(match[2]) ? parseInt(match[2], 10) : 1,
      content: match[4],
      contentIndent: indent + match[2].length + indentWidth(match[3]),
    };
  }

  function splitTableRow(line) {
    const cells = [];
    let cell = "";
    let codeRun = 0;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === "`") {
        let run = 1;
        while (line[i + run] === "`") run++;
        if (!codeRun) codeRun = run;
        else if (codeRun === run) codeRun = 0;
        cell += "`".repeat(run);
        i += run - 1;
      } else if (!codeRun && line[i] === "\\" && line[i + 1] === "|") {
        cell += "\\|";
        i++;
      } else if (!codeRun && line[i] === "|") {
        cells.push(cell.trim());
        cell = "";
      } else {
        cell += line[i];
      }
    }
    cells.push(cell.trim());
    if (!cells[0]) cells.shift();
    if (cells.length && !cells[cells.length - 1]) cells.pop();
    return cells;
  }

  function tableAt(lines, at) {
    if (at + 1 >= lines.length || !lines[at].includes("|") || !lines[at + 1].includes("-")) return null;
    const head = splitTableRow(lines[at]);
    const rule = splitTableRow(lines[at + 1]);
    if (!head.length || head.length !== rule.length || !rule.every(cell => /^:?-{3,}:?$/.test(cell))) return null;
    return { head, rule };
  }

  function blockStart(lines, at) {
    const line = lines[at] || "";
    return !!(fenceStart(line) || headingStart(line) || horizontalRule(line) ||
      /^ {0,3}> ?/.test(line) || listStart(line) || /^( {4}|\t)/.test(line) || tableAt(lines, at));
  }

  function codeBlock(code, language) {
    const label = String(language || "").trim();
    const languageHTML = label ? '<span class="codelang">' + escapeHTML(label) + "</span>" : "";
    const languageData = label ? ' data-language="' + escapeAttribute(label) + '"' : "";
    return '<div class="codeblockwrap"' + languageData + '><button type="button" class="copybtn" title="copy" aria-label="copy code">' +
      COPY_ICON + '</button>' + languageHTML + '<pre class="codeblock"><code>' + escapeHTML(code) + "</code></pre></div>";
  }

  function imageGrid(lines) {
    const rendered = lines.map(line => renderInline(line, 0));
    const image = /<img class="shot"[^>]*>/g;
    let total = 0;
    for (const line of rendered) {
      const matches = line.match(image) || [];
      total += matches.length;
      if (line.replace(image, "").trim()) return "";
    }
    if (total < 2) return "";
    return rendered.map(line => {
      const matches = line.match(image) || [];
      if (matches.length < 2) return matches[0] || "";
      return '<span class="shotgrid" data-n="' + Math.min(matches.length, 4) + '">' + matches.join("") + "</span>";
    }).join("");
  }

  function compactListItem(html) {
    if (html.startsWith("<p>") && html.endsWith("</p>") && html.indexOf("</p>") === html.length - 4) {
      return html.slice(3, -4);
    }
    return html;
  }

  function renderList(lines, start, depth) {
    const first = listStart(lines[start]);
    const tag = first.ordered ? "ol" : "ul";
    const attrs = first.ordered && first.start !== 1 ? ' start="' + first.start + '"' : "";
    const items = [];
    let at = start;
    while (at < lines.length) {
      const marker = listStart(lines[at]);
      if (!marker || marker.indent !== first.indent || marker.ordered !== first.ordered) break;
      const item = [marker.content];
      at++;
      let blank = false;
      while (at < lines.length) {
        const line = lines[at];
        if (!line.trim()) {
          item.push("");
          blank = true;
          at++;
          continue;
        }
        const next = listStart(line);
        const indent = leadingWidth(line);
        if (next && next.indent === first.indent) break;
        if (next && next.indent < first.indent) break;
        if (indent < first.indent) break;
        if (indent === first.indent && blockStart(lines, at)) break;
        if (blank && indent <= first.indent && !next) break;
        item.push(indent > first.indent ? removeIndent(line, marker.contentIndent) : line.slice(first.indent));
        blank = false;
        at++;
      }
      while (item.length && !item[item.length - 1].trim()) item.pop();
      items.push("<li>" + compactListItem(renderBlocks(item, depth + 1)) + "</li>");
    }
    return { html: "<" + tag + attrs + ">" + items.join("") + "</" + tag + ">", at };
  }

  function renderTable(lines, start, table) {
    const alignments = table.rule.map(cell => cell.startsWith(":") && cell.endsWith(":") ? "center" :
      cell.endsWith(":") ? "right" : cell.startsWith(":") ? "left" : "");
    const cell = (tag, value, index) => "<" + tag + (alignments[index] ? ' class="md-align-' + alignments[index] + '"' : "") +
      ">" + renderInline(value, 0) + "</" + tag + ">";
    let html = '<div class="tablewrap"><table><thead><tr>' +
      table.head.map((value, index) => cell("th", value, index)).join("") + "</tr></thead><tbody>";
    let at = start + 2;
    while (at < lines.length && lines[at].trim() && lines[at].includes("|")) {
      // Render exactly the cells supplied by the row. Missing trailing cells
      // need no elements, while cells beyond the header still contain authored
      // data and must remain visible. Mapping every header for a sparse row
      // would amplify H columns by R rows into H*R blank output.
      const values = splitTableRow(lines[at]);
      html += "<tr>" + values.map((value, index) => cell("td", value, index)).join("") + "</tr>";
      at++;
    }
    return { html: html + "</tbody></table></div>", at };
  }

  function renderBlocks(sourceLines, depth) {
    const lines = Array.isArray(sourceLines) ? sourceLines : String(sourceLines || "").split("\n");
    const blockDepth = depth || 0;
    if (blockDepth >= MAX_BLOCK_DEPTH) {
      return lines.length ? "<p>" + lines.map(line => renderInline(line, 0)).join("<br>") + "</p>" : "";
    }
    let html = "";
    let at = 0;
    while (at < lines.length) {
      if (!lines[at].trim()) {
        at++;
        continue;
      }

      const fence = fenceStart(lines[at]);
      if (fence) {
        const marker = fence[1];
        const language = fence[2].trim();
        const close = new RegExp("^ {0,3}" + marker[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "{" + marker.length + ",}\\s*$");
        const code = [];
        at++;
        while (at < lines.length && !close.test(lines[at])) code.push(lines[at++]);
        if (at < lines.length) at++;
        html += codeBlock(code.join("\n"), language);
        continue;
      }

      const heading = headingStart(lines[at]);
      if (heading) {
        html += "<h" + heading.level + ">" + renderInline(heading.text, 0) + "</h" + heading.level + ">";
        at++;
        continue;
      }

      if (horizontalRule(lines[at])) {
        html += "<hr>";
        at++;
        continue;
      }

      const table = tableAt(lines, at);
      if (table) {
        const rendered = renderTable(lines, at, table);
        html += rendered.html;
        at = rendered.at;
        continue;
      }

      if (/^ {0,3}> ?/.test(lines[at])) {
        const quote = [];
        while (at < lines.length && /^ {0,3}> ?/.test(lines[at])) {
          quote.push(lines[at].replace(/^ {0,3}> ?/, ""));
          at++;
        }
        html += "<blockquote>" + renderBlocks(quote, blockDepth + 1) + "</blockquote>";
        continue;
      }

      if (listStart(lines[at])) {
        const rendered = renderList(lines, at, blockDepth);
        html += rendered.html;
        at = rendered.at;
        continue;
      }

      if (/^( {4}|\t)/.test(lines[at])) {
        const code = [];
        while (at < lines.length && (!lines[at].trim() || /^( {4}|\t)/.test(lines[at]))) {
          code.push(lines[at].trim() ? removeIndent(lines[at], 4) : "");
          at++;
        }
        while (code.length && !code[code.length - 1]) code.pop();
        html += codeBlock(code.join("\n"), "");
        continue;
      }

      const paragraph = [lines[at++]];
      while (at < lines.length && lines[at].trim() && !blockStart(lines, at)) paragraph.push(lines[at++]);
      html += imageGrid(paragraph) || "<p>" + paragraph.map(line => renderInline(line, 0)).join("<br>") + "</p>";
    }
    return html;
  }

  function render(source) {
    return renderBlocks(String(source == null ? "" : source).replace(/\r\n?/g, "\n").split("\n"), 0);
  }

  return { render, renderInline, escapeHTML, escapeAttribute, safeLinkTarget, safeImageTarget,
    renderAttachment, attachmentInfo, attachmentFile, ATTACHMENT_TYPES, ATTACHMENT_ACCEPT, MAX_ATTACHMENT_SIZE };
});
