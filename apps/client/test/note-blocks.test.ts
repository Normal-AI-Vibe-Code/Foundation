/**
 * A note's blocks (docs/notes.md): the markdown each block is kept as, drawn as the editor's blocks, and the
 * slash menu's ranking. Reading the blocks back to markdown is htmlToMarkdown's (a page's DOM), checked in
 * e2e/note-pages.spec.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { rankBlocks, renderNote, shortcutOf } from "../src/notes/blocks.ts";

test("to-dos, nested items and numbered lists keep their state and depth", () => {
  const html = renderNote("- [ ] buy rotor\n- [x] call **Acme**\n  - [ ] ask for a quote\n1. one\n  2. two");
  assert.match(html, /<ul class="md-todos">\n<li class="md-todo" data-checked="false">buy rotor<\/li>/);
  assert.match(html, /<li class="md-todo" data-checked="true">call <strong>Acme<\/strong><\/li>/);
  assert.match(html, /<li class="md-todo" data-checked="false" data-indent="1">ask for a quote<\/li>/);
  assert.match(html, /<ol>\n<li>one<\/li>\n<li data-indent="1">two<\/li>\n<\/ol>/);
});

test("a callout is GitHub's alert; a toggle is details and summary, its blocks inside, open or not", () => {
  assert.equal(renderNote("> [!TIP] balance first\n> then mount"), '<div class="md-callout" data-kind="tip" aria-label="Tip"><p>balance first</p><p>then mount</p></div>');
  assert.match(renderNote("> [!WARNING]\n> hot"), /data-kind="warning"[^>]*><p>hot<\/p>/);
  const t = renderNote("<details>\n<summary>Specs</summary>\n\n- 12 V\n- 3 A\n\n</details>\nAfter");
  assert.match(t, /^<div class="md-toggle" data-open="false"><p class="md-toggle-head">Specs<\/p><div class="md-toggle-body"><ul>\n<li>12 V<\/li>\n<li>3 A<\/li>\n<\/ul><\/div><\/div>/);
  assert.match(t, /<p>After<\/p>$/);
  assert.match(renderNote("<details open>\n<summary>x</summary>\ny\n</details>"), /data-open="true"/);
  // toggles nest
  const nested = renderNote("<details>\n<summary>a</summary>\n<details>\n<summary>b</summary>\ninner\n</details>\n</details>");
  assert.equal((nested.match(/md-toggle"/g) ?? []).length, 2);
  assert.match(nested, /<p>inner<\/p><\/div><\/div><\/div><\/div>$/);
});

test("a page line is a page; an address alone is a bookmark; a fence keeps its language", () => {
  assert.equal(renderNote("[Rotor plan](note:rotor-plan)"), '<p class="md-page" data-note="rotor-plan" contenteditable="false"><span class="md-page-title">Rotor plan</span></p>');
  assert.match(renderNote("https://example.com/a?b=1"), /<div class="md-embed" data-url="https:\/\/example.com\/a\?b=1" contenteditable="false"><span class="md-embed-host">example.com<\/span>/);
  assert.equal(renderNote("```ts\nconst a = <b>;\n```"), '<pre data-lang="ts"><code>const a = &lt;b&gt;;</code></pre>');
  // an address inside words stays a word; a javascript: address is never a bookmark
  assert.doesNotMatch(renderNote("see https://example.com"), /md-embed/);
  assert.doesNotMatch(renderNote("javascript:alert(1)"), /md-embed|href/);
});

test("everything stays escaped: a summary, a callout, a page title, an item", () => {
  const html = renderNote('<details>\n<summary><img src=x onerror=alert(1)></summary>\n</details>\n> [!NOTE] <script>x</script>\n[<b>t</b>](note:a)\n- [ ] <i>i</i>');
  assert.doesNotMatch(html, /<img|<script|<b>|<i>/);
  assert.match(html, /&lt;script&gt;/);
});

test("markdown that isn't a block is drawn as before", () => {
  assert.equal(renderNote("# Title\n\nWords **bold**"), "<h1>Title</h1>\n<p>Words <strong>bold</strong></p>");
  assert.match(renderNote("| a |\n|---|\n| 1 |"), /<table>/);
  assert.equal(renderNote(""), "");
});

test("the slash menu: the name or an alias first, then its start, then within; recents first with no query", () => {
  assert.equal(rankBlocks("h2")[0].id, "h2");
  assert.equal(rankBlocks("todo")[0].id, "todo");
  assert.equal(rankBlocks("tog")[0].id, "toggle");
  assert.equal(rankBlocks("warn")[0].id, "callout-warning");
  assert.equal(rankBlocks("call")[0].id, "callout-note");
  assert.equal(rankBlocks("zzz").length, 0);
  assert.deepEqual(rankBlocks("", ["code", "nope", "page"]).slice(0, 2).map((b) => b.id), ["code", "page"]);
});

test("markdown shortcuts at a block's start", () => {
  assert.deepEqual(shortcutOf("# Rotor"), { kind: "h1", rest: "Rotor" });
  assert.deepEqual(shortcutOf("[] "), { kind: "todo", rest: "" });
  assert.deepEqual(shortcutOf(">> "), { kind: "toggle", rest: "" });
  assert.deepEqual(shortcutOf("---"), { kind: "divider", rest: "" });
  assert.equal(shortcutOf("#hashtag"), null);
  assert.equal(shortcutOf("plain words"), null);
});
