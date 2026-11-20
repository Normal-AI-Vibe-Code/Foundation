/**
 * The release page (Changes → Releases, Settings → Releases) draws each post from an outline of the post
 * itself: its opening paragraph, and each `## ` part as a title, a sentence, a kind and a count.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { firstSentence, outlinePost, parsePost, plainWords, releaseKind } from "../src/settings/releases";

const POST = `Opening words with **bold** and a [link](https://example.com). A second sentence.

More opening.

## The plan, synced with GitHub

**Settings → Plan** was a read-only copy. Now an admin can work it.

- **Sync.** It reads every issue.
- **New card.** A bug or a plan.

## Also tonight

- **The desktop app updates itself.** A few seconds after it opens.
- **Fixed:**
  - One thing.
  - Another thing.

## Fixed

- **Search's results are ours.** Not strangers'.
- Loading dots stop.
- Wires keep to their edge.
`;

test("the outline is the post's own words and counts", () => {
  const o = outlinePost(POST);
  assert.equal(o.lede, "Opening words with bold and a link. A second sentence.");
  assert.deepEqual(o.parts.map((p) => [p.title, p.kind, p.count]), [
    ["The plan, synced with GitHub", "plan", 2],
    ["Also tonight", "new", 2],
    ["Fixed", "fix", 3],
  ]);
  assert.equal(o.parts[0].summary, "Settings → Plan was a read-only copy.");
  assert.equal(o.parts[1].summary, "The desktop app updates itself.");
  // the "Fixed:" bullet is not a change; its two indented lines are fixes
  assert.equal(o.changes, 2 + 1);
  assert.equal(o.fixes, 3 + 2);
});

test("a part with no list still counts as one thing", () => {
  const o = outlinePost("Lede.\n\n## Release notes in the app\n\nSettings shows them.\n");
  assert.deepEqual([o.parts[0].count, o.parts[0].kind, o.changes, o.fixes], [1, "release", 1, 0]);
});

test("plain words, first sentences and kinds", () => {
  assert.equal(plainWords("**a** `b` _c_ [d](x)  e"), "a b c d e");
  assert.equal(firstSentence("One. Two."), "One.");
  assert.ok(firstSentence("word ".repeat(80)).endsWith("…"));
  assert.ok(firstSentence("word ".repeat(80)).length <= 151);
  assert.equal(releaseKind("The board says what it means"), "grid");
  assert.equal(releaseKind("Something else entirely"), "new");
});

test("every post in docs/blog outlines: a lede, and parts that each say something", () => {
  const dir = new URL("../../../docs/blog/", import.meta.url);
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md") || f === "README.md") continue;
    const post = parsePost(readFileSync(new URL(f, dir), "utf8"));
    assert.ok(post);
    const o = outlinePost(post.body);
    assert.ok(o.lede.length > 20, `${f}: a lede`);
    assert.ok(o.parts.length > 0, `${f}: parts`);
    for (const p of o.parts) assert.ok(p.title && p.summary, `${f}: ${p.title} has a sentence`);
    assert.ok(o.changes + o.fixes >= o.parts.length);
  }
});
