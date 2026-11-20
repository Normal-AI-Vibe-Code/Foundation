/**
 * Minimal markdown → HTML renderer for note boxes.
 * Supports: # headings, lists (-, *, 1.), **bold**, *italic*, `code`,
 * ``` fenced blocks, [links](url), > quotes, --- rules, | tables |. Input is escaped
 * first, so raw HTML in notes is inert.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** undo escapeHtml, to read an address as written */
const unescapeHtml = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** an address's host, escaped for the page; "" when it isn't an http(s) address */
export function hostOf(escapedUrl: string): string {
  try {
    const u = new URL(unescapeHtml(escapedUrl));
    return /^https?:$/.test(u.protocol) ? escapeHtml(u.host) : "";
  } catch {
    return "";
  }
}

/**
 * The exact address of one of Foundation's own files: `/files/<id>`, where an id is `f_` and 16 hex digits
 * (an upload: apps/server/src/files.ts) or `ff_` and letters, digits, `_` and `-` (brought from Flowform).
 * Nothing else: no `..`, no `.`, no `%` (so no encoded slash or dot), no backslash, no query, no fragment, no
 * host. Any of those could make the browser fetch another of the server's addresses, as the reader.
 */
export const OWN_FILE = /^\/files\/(?:f_[0-9a-f]{16}|ff_[A-Za-z0-9_-]{1,61})$/;

/** an own file's address, also as the browser would read it: normalising it must leave it exactly as written */
export function isOwnFile(url: string): boolean {
  if (!OWN_FILE.test(url)) return false;
  try {
    const u = new URL(url, "http://foundation.invalid");
    return u.origin === "http://foundation.invalid" && u.pathname === url && !u.search && !u.hash;
  } catch {
    return false;
  }
}

/** a picture written into the text itself */
const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|avif);base64,[A-Za-z0-9+/=]+$/;

/**
 * A picture that loads on sight: one of Foundation's own files, by its exact address (isOwnFile), or a
 * picture written into the text itself (a data: image). Any other address would tell its server who is
 * reading, and when, the moment the text is on screen (and what an agent put in its address), and an address
 * that only starts like a file's could reach another of Foundation's own routes as the reader, so it is a
 * placeholder until a person presses.
 */
export const OWN_IMAGE = { test: (url: string) => isOwnFile(url) || DATA_IMAGE.test(url) };

/** the placeholder for a picture from elsewhere: its host, and a press to load it (installRemoteImages) */
function remoteImage(alt: string, url: string): string {
  const host = hostOf(url);
  if (!host) return alt;
  return (
    `<span class="md-img-remote" data-md="remote-img" data-src="${url}" data-alt="${alt}" contenteditable="false">` +
    `<span class="md-img-remote-label">Image from <b>${host}</b></span>` +
    `<button type="button" class="md-img-load" data-load-image>Load image</button></span>`
  );
}

/** a link: its real host beside it (unless the words already say it), opened in a new tab with no opener and no referrer */
function link(text: string, url: string): string {
  const host = hostOf(url);
  if (!host) return text;
  const plain = text.replace(/<[^>]+>/g, "").toLowerCase();
  const bare = host.replace(/^www\./, "").toLowerCase();
  const says = plain.includes(bare);
  return (
    `<a href="${url}" data-ext="1" target="_blank" rel="noopener noreferrer" title="${url}">${text}</a>` +
    (says ? "" : `<span class="md-link-host" data-md="host" contenteditable="false">${host}</span>`)
  );
}

/**
 * Pictures and links first, each set aside as a token so nothing else (bold, italics, code) reaches into an
 * address; then the marks; then the tokens back. Only http(s) addresses become links: no javascript:, data:
 * or vbscript:. A picture is shown only from Foundation's files or a data: image (OWN_IMAGE).
 */
function inline(s: string): string {
  const held: string[] = [];
  const hold = (html: string) => `\u0000${held.push(html) - 1}\u0000`;
  const marked = s
    .replace(/!\[([^\]]*)\]\(([^\s)]+)\)/g, (_m, alt: string, url: string) => hold(OWN_IMAGE.test(url) ? `<img class="md-img" src="${url}" alt="${alt}" loading="lazy">` : remoteImage(alt, url)))
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, text: string, url: string) => hold(link(marks(text), url)));
  // a link's words may hold a picture's token: put tokens back until none are left
  const restore = (x: string): string => x.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => restore(held[Number(i)] ?? ""));
  return restore(marks(marked));
}

function marks(s: string): string {
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    // what a text box adds. _italic_ only at a word's edges, so snake_case stays as typed;
    // <u> is the one tag let back in after escaping, with nothing on it
    .replace(/&lt;u&gt;(.+?)&lt;\/u&gt;/g, "<u>$1</u>")
    .replace(/~~([^~]+)~~/g, "<s>$1</s>")
    .replace(/(^|[\s(>*~])_([^_\n]+)_(?=$|[\s).,;:!?<*~])/g, "$1<em>$2</em>");
}

/**
 * Pictures from elsewhere load only when a person presses "Load image" on one: that one, this time (nothing
 * is remembered). One listener for every place rendered markdown is shown (notes, sessions, readmes, Slack
 * text, release notes); installed once at start.
 */
export function installRemoteImages(doc: Document = document) {
  doc.addEventListener(
    "click",
    (e) => {
      const button = (e.target as HTMLElement | null)?.closest?.("[data-load-image]");
      const holder = button?.closest(".md-img-remote") as HTMLElement | null;
      if (!holder) return;
      e.preventDefault();
      e.stopPropagation();
      const src = holder.dataset.src ?? "";
      if (!hostOf(escapeHtml(src))) return;
      const img = doc.createElement("img");
      img.className = "md-img";
      img.alt = holder.dataset.alt ?? "";
      img.referrerPolicy = "no-referrer";
      img.src = src;
      holder.replaceWith(img);
    },
    true,
  );
}

/** a table row: | a | b | */
const isRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
/** the line under a table's header: |---|:--:| */
const isRule = (l: string) => /^\s*\|(\s*:?-+:?\s*\|)+\s*$/.test(l);
const cells = (l: string) => l.trim().slice(1, -1).split("|").map((c) => c.trim());

export function renderMarkdown(src: string): string {
  // \u0000 marks inline()'s tokens: never taken from the text
  const lines = escapeHtml(src.replace(/\u0000/g, "")).split(/\r?\n/);
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  let inCode = false;

  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!inCode && isRow(line) && i + 1 < lines.length && isRule(lines[i + 1])) {
      closeList();
      const head = cells(line);
      const body: string[][] = [];
      for (i += 2; i < lines.length && isRow(lines[i]); i++) body.push(cells(lines[i]));
      i--;
      const tr = (r: string[], tag: "th" | "td") => `<tr>${head.map((_, j) => `<${tag}>${inline(r[j] ?? "")}</${tag}>`).join("")}</tr>`;
      out.push(`<div class="md-table"><table><thead>${tr(head, "th")}</thead><tbody>${body.map((r) => tr(r, "td")).join("")}</tbody></table></div>`);
      continue;
    }

    if (line.trim().startsWith("```")) {
      closeList();
      if (inCode) {
        out.push("</code></pre>");
        inCode = false;
      } else {
        out.push("<pre><code>");
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      out.push(line);
      continue;
    }

    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      closeList();
      const lvl = h[1].length;
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      continue;
    }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
      closeList();
      out.push("<hr>");
      continue;
    }
    const quote = /^&gt;\s?(.*)$/.exec(line);
    if (quote) {
      closeList();
      out.push(`<blockquote>${inline(quote[1])}</blockquote>`);
      continue;
    }
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    if (ul) {
      if (list !== "ul") {
        closeList();
        out.push("<ul>");
        list = "ul";
      }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ol) {
      if (list !== "ol") {
        closeList();
        out.push("<ol>");
        list = "ol";
      }
      out.push(`<li>${inline(ol[1])}</li>`);
      continue;
    }
    closeList();
    if (line.trim() === "") continue;
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  if (inCode) out.push("</code></pre>");
  return out.join("\n");
}
