/**
 * A person's list preferences (prefs.ts `LIST_PREFS`): `chat.pinned`, the ChatForm conversations they keep
 * in the side menu, in their order. Each person their own; an ordered list of at most 100 short distinct
 * ids; anything else is refused and what was there stays. The word preferences read as before.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-test-"));

const { upsertUser } = await import("../src/auth.ts");
const { listPrefsOf, prefsOf, setPref } = await import("../src/prefs.ts");
const { run } = await import("../src/db.ts");

const ada = upsertUser("ada@formindustries.com", "Ada Lovelace");
const kai = upsertUser("kai@formindustries.com", "Kai");

test("chat.pinned: empty until set, then the person's own order, each person their own", () => {
  assert.deepEqual(listPrefsOf(ada.id), { "chat.pinned": [] });
  setPref(ada.id, "chat.pinned", ["ch_general", "ch_design"]);
  assert.deepEqual(listPrefsOf(ada.id)["chat.pinned"], ["ch_general", "ch_design"]);
  setPref(ada.id, "chat.pinned", ["ch_design", "ch_general"]);
  assert.deepEqual(listPrefsOf(ada.id)["chat.pinned"], ["ch_design", "ch_general"]);
  assert.deepEqual(listPrefsOf(kai.id)["chat.pinned"], []);
  // repeats are kept once, first place wins
  setPref(kai.id, "chat.pinned", ["a", "b", "a"]);
  assert.deepEqual(listPrefsOf(kai.id)["chat.pinned"], ["a", "b"]);
  // emptied
  setPref(kai.id, "chat.pinned", []);
  assert.deepEqual(listPrefsOf(kai.id)["chat.pinned"], []);
});

test("chat.pinned: only a list of at most 100 short ids; a refused value leaves what was there", () => {
  const was = listPrefsOf(ada.id)["chat.pinned"];
  assert.throws(() => setPref(ada.id, "chat.pinned", "ch_general"), /list of ids/);
  assert.throws(() => setPref(ada.id, "chat.pinned", { 0: "ch_general" }), /list of ids/);
  assert.throws(() => setPref(ada.id, "chat.pinned", [1, 2]), /list of ids/);
  assert.throws(() => setPref(ada.id, "chat.pinned", [""]), /list of ids/);
  assert.throws(() => setPref(ada.id, "chat.pinned", ["x".repeat(121)]), /list of ids/);
  assert.throws(() => setPref(ada.id, "chat.pinned", ["a\nb"]), /list of ids/);
  assert.throws(() => setPref(ada.id, "chat.pinned", Array.from({ length: 101 }, (_, i) => `c${i}`)), /at most 100/);
  assert.deepEqual(listPrefsOf(ada.id)["chat.pinned"], was);
  setPref(ada.id, "chat.pinned", Array.from({ length: 100 }, (_, i) => `c${i}`));
  assert.equal(listPrefsOf(ada.id)["chat.pinned"].length, 100);
});

test("the word preferences are as they were: a list key doesn't show among them, nor take their values", () => {
  assert.deepEqual(prefsOf(ada.id), { computer_use: "ask" });
  assert.deepEqual(setPref(ada.id, "chat.pinned", ["ch_general"]), { computer_use: "ask" });
  assert.throws(() => setPref(ada.id, "chat.unpinned", []), /no preference called/);
  assert.throws(() => setPref(ada.id, "computer_use", ["never"]), /one of: ask, never/);
});

test("a stored value that no longer reads is an empty list, not an error", () => {
  run("update person_prefs set value = ? where user_id = ? and key = ?", "{not json", ada.id, "chat.pinned");
  assert.deepEqual(listPrefsOf(ada.id)["chat.pinned"], []);
  run("update person_prefs set value = ? where user_id = ? and key = ?", JSON.stringify(["ok", 3, null, "fine"]), ada.id, "chat.pinned");
  assert.deepEqual(listPrefsOf(ada.id)["chat.pinned"], ["ok", "fine"]);
});
