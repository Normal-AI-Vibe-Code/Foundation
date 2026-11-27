/**
 * Editing a note's blocks in place (docs/notes.md §3): which block the caret is in, turning a block into
 * another, indenting a list item, folding a toggle, ticking a to-do, moving a block. These change the
 * editing surface; RichNote reads it back as markdown and writes the smallest edit, as it does for typing.
 */

import { CALLOUT_KINDS, bookmarkHtml, calloutHtml, pageHtml, toggleHtml, type BlockKind, type CalloutKind } from "./blocks";
import { escapeText, inlineMarkdown } from "../utils/markdown";

/** the blocks a person moves and turns: the surface's own children, and those inside a toggle's body */
export function blockOf(root: HTMLElement, node: Node | null): HTMLElement | null {
  let el: Node | null = node;
  while (el && el !== root) {
    const parent: HTMLElement | null = el.parentElement;
    if (!parent) return null;
    if (el instanceof HTMLElement && (parent === root || parent.classList.contains("md-toggle-body"))) return el;
    el = parent;
  }
  return null;
}

/** the block the caret is in (null outside the surface) */
export function caretBlock(root: HTMLElement): HTMLElement | null {
  const sel = window.getSelection();
  if (!sel?.rangeCount || !root.contains(sel.anchorNode)) return null;
  return blockOf(root, sel.anchorNode);
}

/** the line the caret is in: a list item, a callout's paragraph, a toggle's head, else the block */
export function caretLine(root: HTMLElement): HTMLElement | null {
  const sel = window.getSelection();
  if (!sel?.rangeCount || !root.contains(sel.anchorNode)) return null;
  const at = sel.anchorNode instanceof HTMLElement ? sel.anchorNode : sel.anchorNode?.parentElement;
  const line = at?.closest("li, .md-callout > p, .md-toggle-head, .md-toggle-body > *, h1, h2, h3, h4, p, blockquote, pre");
  return line && root.contains(line) ? (line as HTMLElement) : caretBlock(root);
}

/** how many characters of the line come before the caret */
export function caretIn(line: HTMLElement): number | null {
  const sel = window.getSelection();
  if (!sel?.rangeCount || !line.contains(sel.anchorNode)) return null;
  const r = document.createRange();
  r.selectNodeContents(line);
  r.setEnd(sel.anchorNode!, sel.anchorOffset);
  return r.toString().length;
}

export function caretToEnd(el: HTMLElement) {
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(false);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(r);
}

export function caretToStart(el: HTMLElement) {
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(r);
}

/** the words of a block, as inline HTML (a list's first item, a callout's first paragraph, a toggle's head) */
function wordsOf(block: HTMLElement): string {
  if (block.matches("ul, ol")) return block.querySelector("li")?.innerHTML ?? "";
  if (block.matches(".md-callout")) return [...block.querySelectorAll(":scope > p")].map((p) => p.innerHTML).filter((h) => h && h !== "<br>").join(" ");
  if (block.matches(".md-toggle")) return block.querySelector(".md-toggle-head")?.innerHTML ?? "";
  if (block.matches(".md-page, .md-embed, hr")) return "";
  if (block.matches("pre")) return escapeText(block.textContent ?? "");
  return block.innerHTML;
}

const html = (s: string): HTMLElement => {
  const t = document.createElement("template");
  t.innerHTML = s.trim();
  return t.content.firstElementChild as HTMLElement;
};

/**
 * Turn the block into another kind, keeping its words. Returns the element the caret goes into. A divider,
 * a page and a bookmark take the block's place and leave an empty line after them to go on writing in.
 */
export function turnInto(block: HTMLElement, kind: BlockKind, extra: { url?: string; page?: { id: string; title: string } } = {}): HTMLElement {
  const words = wordsOf(block);
  const w = words && words !== "<br>" ? words : "<br>";
  // a list item that is one of several: only that item changes kind (it leaves its list where it stood)
  const li = block.matches("ul, ol") && block.querySelectorAll("li").length > 1 ? (window.getSelection()?.anchorNode?.parentElement?.closest("li") as HTMLElement | null) : null;
  let made: HTMLElement;
  let caret: HTMLElement;
  if (kind === "p" || kind === "h1" || kind === "h2" || kind === "h3") {
    made = document.createElement(kind);
    made.innerHTML = w;
    caret = made;
  } else if (kind === "ul" || kind === "ol" || kind === "todo") {
    made = html(kind === "todo" ? `<ul class="md-todos"><li class="md-todo" data-checked="false">${w}</li></ul>` : `<${kind}><li>${w}</li></${kind}>`);
    caret = made.querySelector("li")!;
  } else if (kind === "quote") {
    made = document.createElement("blockquote");
    made.innerHTML = w;
    caret = made;
  } else if (kind.startsWith("callout-")) {
    const k = kind.slice(8) as CalloutKind;
    made = html(calloutHtml(CALLOUT_KINDS.includes(k) ? k : "note", []));
    made.querySelector("p")!.innerHTML = w;
    caret = made.querySelector("p")!;
  } else if (kind === "toggle") {
    made = html(toggleHtml("", "", true));
    made.querySelector(".md-toggle-head")!.innerHTML = w;
    caret = made.querySelector(".md-toggle-head")!;
  } else if (kind === "code") {
    made = html(`<pre><code>${words && words !== "<br>" ? escapeText(block.textContent ?? "") : "\n"}</code></pre>`);
    caret = made.querySelector("code")!;
  } else {
    made =
      kind === "divider"
        ? document.createElement("hr")
        : kind === "page" && extra.page
          ? html(pageHtml(extra.page.id, extra.page.title))
          : kind === "bookmark" && extra.url
            ? html(bookmarkHtml(extra.url))
            : kind === "image" && extra.url
              ? // drawn as the note draws a picture: one of Foundation's files shows, one from elsewhere waits for a press
                html(`<p>${inlineMarkdown(`![](${extra.url.replace(/[()\s]/g, encodeURIComponent)})`)}</p>`)
              : document.createElement("p");
    caret = document.createElement("p");
    caret.innerHTML = "<br>";
  }
  if (li) {
    // split the list around the item: the part above, the new block, the part below
    const list = li.parentElement!;
    const below = list.cloneNode(false) as HTMLElement;
    while (li.nextSibling) below.appendChild(li.nextSibling);
    li.remove();
    list.after(made);
    if (below.childNodes.length) made.after(below);
    if (!list.querySelector("li")) list.remove();
  } else block.replaceWith(made);
  if (caret.parentElement === null && caret !== made) made.after(caret);
  return caret;
}

/** a list item a level in (by) or out: two spaces a level in its markdown, four at most */
export function indentItem(li: HTMLElement, by: 1 | -1): boolean {
  const now = Number(li.dataset.indent ?? 0);
  const next = Math.max(0, Math.min(4, now + by));
  if (next === now) return false;
  if (next) li.dataset.indent = String(next);
  else delete li.dataset.indent;
  return true;
}

/** a press on a to-do's box (the item's left gutter) ticks it */
export function todoHit(li: HTMLElement, clientX: number): boolean {
  const r = li.getBoundingClientRect();
  const scale = li.offsetWidth ? r.width / li.offsetWidth : 1;
  const pad = parseFloat(getComputedStyle(li).paddingLeft) || 22;
  return clientX - r.left < pad * scale + 2;
}

/** a press on a toggle's arrow (its head's left gutter) folds or unfolds it */
export function toggleHit(head: HTMLElement, clientX: number): boolean {
  return todoHit(head, clientX);
}

/** move a block before or after another (a drag by its handle) */
export function moveBlock(block: HTMLElement, target: HTMLElement, after: boolean) {
  if (block === target || block.contains(target)) return;
  if (after) target.after(block);
  else target.before(block);
}

/** the top-level blocks under a toggle's body and the surface, in order, for a drag's drop line */
export function dropBlocks(root: HTMLElement): HTMLElement[] {
  return [...root.children].filter((c): c is HTMLElement => c instanceof HTMLElement);
}

const INLINE_ROOT = (n: Node) => n.nodeType === Node.TEXT_NODE || (n instanceof HTMLElement && /^(B|I|U|S|EM|STRONG|CODE|A|SPAN|BR|IMG)$/.test(n.tagName) && !n.classList.contains("md-embed"));

/**
 * Words written straight into the surface (an empty note: the browser puts the first letters there, in no block)
 * go into a paragraph, so every line is a block the slash menu and the shortcuts can turn. The caret stays where it
 * was among the words.
 */
export function ensureBlocks(root: HTMLElement) {
  if (![...root.childNodes].some((n) => INLINE_ROOT(n) && !(n.nodeType === Node.TEXT_NODE && !(n.textContent ?? "").trim() && n.nextSibling))) return;
  const sel = window.getSelection();
  let at: number | null = null;
  if (sel?.rangeCount && root.contains(sel.anchorNode)) {
    const r = document.createRange();
    r.selectNodeContents(root);
    r.setEnd(sel.anchorNode!, sel.anchorOffset);
    at = r.toString().length;
  }
  let p: HTMLElement | null = null;
  for (const n of [...root.childNodes]) {
    if (INLINE_ROOT(n)) {
      if (!p) {
        p = document.createElement("p");
        n.before(p);
      }
      p.appendChild(n);
    } else p = null;
  }
  if (at === null) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let left = at;
  for (let t = walker.nextNode() as Text | null; t; t = walker.nextNode() as Text | null) {
    if (left <= t.length) {
      sel!.collapse(t, left);
      return;
    }
    left -= t.length;
  }
}

/** an empty surface gets its first paragraph to write in, with the caret in it */
export function firstLine(root: HTMLElement) {
  if (root.firstChild) return;
  const p = document.createElement("p");
  p.innerHTML = "<br>";
  root.appendChild(p);
  caretToStart(p);
}

/** an empty line after the block, to write in (after a divider, at the end of a box) */
export function lineAfter(block: HTMLElement): HTMLElement {
  const p = document.createElement("p");
  p.innerHTML = "<br>";
  block.after(p);
  return p;
}
