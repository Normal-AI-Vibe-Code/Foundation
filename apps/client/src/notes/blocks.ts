/**
 * A note's blocks (2026-11-26, docs/notes.md): the note is markdown, and these are the blocks a person writes
 * it in. `renderNote` draws the markdown as the editing surface's blocks; RichText.tsx's `htmlToMarkdown`
 * reads them back. What each block is kept as, so search, agents and the timeline read plain markdown:
 *
 *   to-do          `- [ ] words` / `- [x] words`
 *   nested item    two spaces a level before `- `, `1. ` or `- [ ] `
 *   callout        `> [!NOTE] words` (GitHub's alerts: NOTE, TIP, IMPORTANT, WARNING, CAUTION)
 *   toggle         `<details>` / `<details open>`, `<summary>head</summary>`, its blocks, `</details>`
 *   page           `[Title](note:<id>)` alone on its line: a note page inside this one
 *   bookmark       an http(s) address alone on its line (opens on a press; nothing loads on sight)
 *   code           a fence with its language: ```ts
 *
 * Everything else (headings, paragraphs, quotes, tables, rules, pictures) is `renderMarkdown`'s.
 *
 * The slash menu's blocks (`NOTE_BLOCKS`) and how a query ranks them (`rankBlocks`) are here too. Ideas from
 * flowplan's slash menu (yannicschuller/flowplan, AGPL-3.0: the behaviour, not the code): a match on the
 * name first, then on an alias, then within; recently used blocks first when nothing is typed.
 */

import { NOTE_LINK } from "@foundation/protocol";
import { escapeText, hostOf, inlineMarkdown, renderMarkdown } from "../utils/markdown.ts";

export const CALLOUT_KINDS = ["note", "tip", "important", "warning", "caution"] as const;
export type CalloutKind = (typeof CALLOUT_KINDS)[number];
export const CALLOUT_NAMES: Record<CalloutKind, string> = { note: "Note", tip: "Tip", important: "Important", warning: "Warning", caution: "Caution" };

const LIST = /^(\s*)(?:([-*])\s+\[( |x|X)\]\s?(.*)|([-*])\s+(.*)|(\d+)[.)]\s+(.*))$/;
const CALLOUT = /^>\s?\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s?(.*)$/i;
const BARE_URL = /^https?:\/\/[^\s<>"]+$/;
const FENCE = /^\s*```\s*([A-Za-z0-9_+.#-]{0,24})\s*$/;

/** how deep a list line sits: two spaces (or a tab) a level, at most four */
const depthOf = (lead: string) => Math.min(4, Math.floor(lead.replace(/\t/g, "  ").length / 2));

/** the note's markdown as the editor's blocks (HTML; every word escaped, only http(s) links, pictures by renderMarkdown's rule) */
export function renderNote(md: string): string {
  return renderLines(md.replace(/\r\n?/g, "\n").replace(/\u0000/g, "").split("\n"));
}

function renderLines(lines: string[]): string {
  const out: string[] = [];
  let plain: string[] = [];
  const flush = () => {
    if (plain.some((l) => l.trim())) out.push(renderMarkdown(plain.join("\n")));
    plain = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    // a toggle: its head, then its blocks to the matching </details>
    const open = /^<details(\s+open)?\s*>$/i.exec(t);
    if (open) {
      let depth = 1;
      let j = i + 1;
      let head = "";
      const body: string[] = [];
      for (; j < lines.length; j++) {
        const lt = lines[j].trim();
        if (/^<details(\s+open)?\s*>$/i.test(lt)) depth++;
        if (/^<\/details>$/i.test(lt) && --depth === 0) break;
        const s = depth === 1 && !head ? /^<summary>(.*)<\/summary>$/i.exec(lt) : null;
        if (s) head = s[1];
        else body.push(lines[j]);
      }
      flush();
      out.push(toggleHtml(head, renderLines(body), !!open[1]));
      i = j;
      continue;
    }
    // a fence: its language kept
    const fence = FENCE.exec(line);
    if (fence) {
      let j = i + 1;
      const code: string[] = [];
      for (; j < lines.length && !/^\s*```\s*$/.test(lines[j]); j++) code.push(lines[j]);
      flush();
      out.push(`<pre${fence[1] ? ` data-lang="${escapeText(fence[1])}"` : ""}><code>${escapeText(code.join("\n"))}</code></pre>`);
      i = j;
      continue;
    }
    // a callout: its first line, and the quote lines that follow it
    const callout = CALLOUT.exec(t);
    if (callout) {
      const words = callout[2] ? [callout[2]] : [];
      while (i + 1 < lines.length && /^>/.test(lines[i + 1].trim()) && !CALLOUT.test(lines[i + 1].trim())) words.push(lines[++i].trim().replace(/^>\s?/, ""));
      flush();
      out.push(calloutHtml(callout[1].toLowerCase() as CalloutKind, words));
      continue;
    }
    // a run of list lines: bullets, numbers and to-dos, each at its depth
    if (LIST.test(line)) {
      const run: string[] = [];
      while (i < lines.length && LIST.test(lines[i])) run.push(lines[i++]);
      i--;
      flush();
      out.push(listHtml(run));
      continue;
    }
    const page = NOTE_LINK.exec(t);
    if (page) {
      flush();
      out.push(pageHtml(page[2], page[1]));
      continue;
    }
    if (BARE_URL.test(t) && hostOf(escapeText(t))) {
      flush();
      out.push(bookmarkHtml(t));
      continue;
    }
    // a blank line ends a paragraph; everything else is renderMarkdown's
    plain.push(line);
    if (!t) flush();
  }
  flush();
  return out.join("\n");
}

function listHtml(run: string[]): string {
  const out: string[] = [];
  let kind: "ul" | "ol" | "todo" | null = null;
  const close = () => {
    if (kind) out.push(kind === "ol" ? "</ol>" : "</ul>");
    kind = null;
  };
  for (const line of run) {
    const m = LIST.exec(line)!;
    const k = m[2] ? "todo" : m[5] ? "ul" : "ol";
    if (k !== kind) {
      close();
      out.push(k === "todo" ? '<ul class="md-todos">' : k === "ul" ? "<ul>" : "<ol>");
      kind = k;
    }
    const depth = depthOf(m[1]);
    const words = m[4] ?? m[6] ?? m[8] ?? "";
    const attrs = (k === "todo" ? ` class="md-todo" data-checked="${m[3].trim() ? "true" : "false"}"` : "") + (depth ? ` data-indent="${depth}"` : "");
    out.push(`<li${attrs}>${inlineMarkdown(words) || "<br>"}</li>`);
  }
  close();
  return out.join("\n");
}

export function calloutHtml(kind: CalloutKind, words: string[]): string {
  const paras = (words.length ? words : [""]).map((w) => `<p>${inlineMarkdown(w) || "<br>"}</p>`).join("");
  return `<div class="md-callout" data-kind="${kind}" aria-label="${CALLOUT_NAMES[kind]}">${paras}</div>`;
}

export function toggleHtml(head: string, bodyHtml: string, open: boolean): string {
  return `<div class="md-toggle" data-open="${open}"><p class="md-toggle-head">${inlineMarkdown(head) || "<br>"}</p><div class="md-toggle-body">${bodyHtml || "<p><br></p>"}</div></div>`;
}

/** a page inside this one: the title as written, put right by the editor from the page's own name when it can see it */
export function pageHtml(id: string, title: string): string {
  return `<p class="md-page" data-note="${escapeText(id)}" contenteditable="false"><span class="md-page-title">${escapeText(title) || "Untitled note"}</span></p>`;
}

/** an address on its own: a card with its host, opened on a press (never a frame: nothing of the site runs here) */
export function bookmarkHtml(url: string): string {
  const u = escapeText(url);
  return `<div class="md-embed" data-url="${u}" contenteditable="false"><span class="md-embed-host">${hostOf(u)}</span><span class="md-embed-url">${u}</span></div>`;
}

/** a page line for a note page */
export const pageLine = (title: string, id: string) => `[${title.replace(/[[\]\n]/g, "")}](note:${id})`;

// ---------- the slash menu's blocks ----------

export type BlockKind =
  | "p"
  | "h1"
  | "h2"
  | "h3"
  | "ul"
  | "ol"
  | "todo"
  | "toggle"
  | "quote"
  | `callout-${CalloutKind}`
  | "code"
  | "divider"
  | "image"
  | "bookmark"
  | "page";

export interface BlockCommand {
  id: BlockKind;
  name: string;
  hint: string;
  /** what else finds it: `/h2`, `/todo`, `/hr` */
  aliases: string[];
  /** the markdown shortcut that makes it at a block's start, said in the menu */
  md?: string;
  group: "text" | "lists" | "blocks" | "media";
}

export const NOTE_BLOCKS: BlockCommand[] = [
  { id: "p", name: "Text", hint: "Plain words", aliases: ["paragraph", "body", "plain"], group: "text" },
  { id: "h1", name: "Title", hint: "A large heading", aliases: ["h1", "heading1", "heading 1"], md: "#", group: "text" },
  { id: "h2", name: "Heading", hint: "A section's heading", aliases: ["h2", "heading2", "heading 2"], md: "##", group: "text" },
  { id: "h3", name: "Subheading", hint: "A small heading", aliases: ["h3", "heading3", "heading 3"], md: "###", group: "text" },
  { id: "ul", name: "Bulleted list", hint: "A simple list", aliases: ["bullet", "ul", "list", "unordered"], md: "-", group: "lists" },
  { id: "ol", name: "Numbered list", hint: "A list in order", aliases: ["number", "ol", "ordered", "1."], md: "1.", group: "lists" },
  { id: "todo", name: "To-do list", hint: "Things to tick off", aliases: ["todo", "task", "checkbox", "check", "[]"], md: "[]", group: "lists" },
  { id: "toggle", name: "Toggle", hint: "A head that folds what's under it", aliases: ["details", "collapse", "fold", "dropdown"], md: ">>", group: "blocks" },
  { id: "quote", name: "Quote", hint: "Words set apart", aliases: ["blockquote", "cite"], md: ">", group: "blocks" },
  { id: "callout-note", name: "Callout", hint: "A note set in a box", aliases: ["callout", "note", "info", "aside"], md: "!", group: "blocks" },
  { id: "callout-tip", name: "Callout: tip", hint: "Something helpful", aliases: ["tip", "hint"], group: "blocks" },
  { id: "callout-important", name: "Callout: important", hint: "Something to know", aliases: ["important"], group: "blocks" },
  { id: "callout-warning", name: "Callout: warning", hint: "Something to watch", aliases: ["warning", "warn"], group: "blocks" },
  { id: "callout-caution", name: "Callout: caution", hint: "Something that can go wrong", aliases: ["caution", "danger"], group: "blocks" },
  { id: "code", name: "Code", hint: "Code, as written", aliases: ["code", "pre", "snippet", "```"], md: "```", group: "blocks" },
  { id: "divider", name: "Divider", hint: "A line across", aliases: ["hr", "rule", "line", "separator", "---"], md: "---", group: "blocks" },
  { id: "page", name: "Page", hint: "A note inside this one", aliases: ["page", "subpage", "sub-page", "note", "child"], group: "media" },
  { id: "image", name: "Image", hint: "A picture by its address", aliases: ["image", "picture", "photo", "img"], group: "media" },
  { id: "bookmark", name: "Link", hint: "A web address as a card", aliases: ["bookmark", "embed", "url", "link", "web"], group: "media" },
];

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, "");

/** the blocks a query finds, best first: the name exactly or an alias, the name's start, an alias's start, a word's start, within, the hint */
export function rankBlocks(query: string, recents: string[] = [], all: BlockCommand[] = NOTE_BLOCKS): BlockCommand[] {
  const q = norm(query);
  if (!q) {
    const recent = recents.map((id) => all.find((b) => b.id === id)).filter((b): b is BlockCommand => !!b).slice(0, 3);
    return [...recent, ...all.filter((b) => !recent.includes(b))];
  }
  const score = (b: BlockCommand) => {
    const name = norm(b.name);
    const aliases = b.aliases.map(norm);
    if (name === q || aliases.includes(q)) return 0;
    if (name.startsWith(q)) return 1;
    if (aliases.some((a) => a.startsWith(q))) return 2;
    if (b.name.split(/[\s:-]+/).some((w) => norm(w).startsWith(q))) return 3;
    if (name.includes(q) || aliases.some((a) => a.includes(q))) return 4;
    if (norm(b.hint).includes(q)) return 5;
    return -1;
  };
  return all
    .map((b, i) => ({ b, i, s: score(b) }))
    .filter((x) => x.s >= 0)
    .sort((a, z) => a.s - z.s || a.i - z.i)
    .map((x) => x.b);
}

/** the markdown shortcut at a block's start that turns it into a block, and what's left of its words */
export function shortcutOf(text: string): { kind: BlockKind; rest: string } | null {
  const t = text.replace(/ /g, " ");
  const m = /^(#{1,3}|[-*]|1[.)]|\[\s?\]|\[x\]|>>|>|!|```|---)\s(.*)$/s.exec(t) ?? /^(```|---)$/.exec(t);
  if (!m) return null;
  const rest = m[2] ?? "";
  switch (m[1]) {
    case "#":
      return { kind: "h1", rest };
    case "##":
      return { kind: "h2", rest };
    case "###":
      return { kind: "h3", rest };
    case "-":
    case "*":
      return { kind: "ul", rest };
    case "1.":
    case "1)":
      return { kind: "ol", rest };
    case "[]":
    case "[ ]":
    case "[x]":
      return { kind: "todo", rest };
    case ">>":
      return { kind: "toggle", rest };
    case ">":
      return { kind: "quote", rest };
    case "!":
      return { kind: "callout-note", rest };
    case "```":
      return { kind: "code", rest };
    case "---":
      return { kind: "divider", rest };
  }
  return null;
}

// ---------- recently used blocks (this browser's) ----------

const RECENTS = "foundation-note-blocks";
export function readRecents(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENTS) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 5) : [];
  } catch {
    return [];
  }
}
export function noteRecent(id: string) {
  try {
    localStorage.setItem(RECENTS, JSON.stringify([id, ...readRecents().filter((x) => x !== id)].slice(0, 5)));
  } catch { /* a private window */ }
}
