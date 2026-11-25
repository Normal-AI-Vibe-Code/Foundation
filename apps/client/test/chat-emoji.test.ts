/**
 * ChatForm's emoji (src/chat/emoji.ts): the curated set is sound (about eighty, nothing twice, every one
 * named and found by its name), `:name` finds them, and recents keep the newest first.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { slackEmoji } from "@foundation/protocol";
import { ALL_EMOJI, EMOJI_GROUPS, emojiName, matchEmoji, pushRecent, RECENTS_MAX } from "../src/chat/emoji.ts";

test("about eighty emoji in a few groups, each once, each with names in shortcode form", () => {
  assert.ok(ALL_EMOJI.length >= 70 && ALL_EMOJI.length <= 100, `${ALL_EMOJI.length} emoji`);
  assert.ok(EMOJI_GROUPS.length >= 3 && EMOJI_GROUPS.every((g) => g.emoji.length > 0 && g.name));
  const chars = ALL_EMOJI.map((e) => e.char);
  assert.equal(new Set(chars).size, chars.length, "no emoji twice");
  for (const e of ALL_EMOJI) {
    assert.ok(e.names.length > 0, e.char);
    for (const n of e.names) assert.match(n, /^[a-z0-9_+-]+$/, `${e.char} ${n}`);
    assert.ok(!/^[\x20-\x7e]+$/.test(e.char), `${e.char} is a character, not a word`);
  }
});

test("Slack's common shortcodes land on the same characters here", () => {
  for (const code of ["+1", "tada", "eyes", "fire", "rocket", "white_check_mark", "pray", "joy", "thinking_face", "100", "heart"]) {
    const here = matchEmoji(code, 1)[0];
    assert.ok(here, code);
    assert.equal(here.char, slackEmoji(code), code);
  }
});

test(":name finds by the start of a name first", () => {
  assert.equal(matchEmoji("thumb")[0].char, "👍");
  assert.equal(matchEmoji(":tada:")[0].char, "🎉");
  assert.ok(matchEmoji("sm").length > 1);
  assert.deepEqual(matchEmoji("zzzz"), []);
  assert.equal(matchEmoji("", 5).length, 5);
  assert.equal(emojiName("👍"), ":+1:");
});

test("recents: the newest first, nothing twice, at most sixteen", () => {
  let r: string[] = [];
  for (const c of ["👍", "🎉", "👍"]) r = pushRecent(r, c);
  assert.deepEqual(r, ["👍", "🎉"]);
  for (const e of ALL_EMOJI.slice(0, 30)) r = pushRecent(r, e.char);
  assert.equal(r.length, RECENTS_MAX);
  assert.equal(r[0], ALL_EMOJI[29].char);
});
