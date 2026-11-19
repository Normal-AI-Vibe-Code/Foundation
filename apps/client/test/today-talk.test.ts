/**
 * Today's pure parts: the Shiba's answer in prose and folded blocks, the badge's count, and
 * pictures in markdown.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { countNotices, partsOf } from "../src/today/talk.ts";
import { renderMarkdown } from "../src/utils/markdown.ts";

const FENCE = "```";

test("an answer splits into prose and each fenced block; a fence still arriving is code", () => {
  const parts = partsOf(["Run this:", "", `${FENCE}bash`, "npm test", "npm run typecheck", FENCE, "", "Then this:", `${FENCE}ts`, "const a = 1;"].join("\n"));
  assert.deepEqual(
    parts.map((p) => p.kind),
    ["text", "code", "text", "code"],
  );
  assert.deepEqual(parts[1], { kind: "code", lang: "bash", text: "npm test\nnpm run typecheck" });
  assert.deepEqual(parts[3], { kind: "code", lang: "ts", text: "const a = 1;" });
  assert.deepEqual(partsOf("Just words."), [{ kind: "text", text: "Just words." }]);
  assert.deepEqual(partsOf(""), []);
});

test("the badge counts what waits, by who it's from; related work doesn't wait", () => {
  const n = countNotices([{ kind: "ask" }, { kind: "mention" }, { kind: "stage", tone: "agent" }, { kind: "file" }, { kind: "changes" }, { kind: "related" }]);
  assert.deepEqual(n, { people: 2, agents: 1, changes: 2 });
  assert.deepEqual(countNotices([]), { people: 0, agents: 0, changes: 0 });
});

test("a picture in markdown loads on sight only from Foundation's files or the text itself; the web's waits for a press", () => {
  assert.ok(renderMarkdown("![Rim drive](/files/f_0123456789abcdef)").includes('<img class="md-img" src="/files/f_0123456789abcdef" alt="Rim drive"'));
  // the web's: a placeholder with its host and Load image (utils/markdown.ts), not an <img>
  const web = renderMarkdown("![x](https://example.com/a.png)");
  assert.ok(!web.includes("<img") && web.includes('data-src="https://example.com/a.png"') && web.includes("Load image"));
  assert.ok(!renderMarkdown("![x](javascript:alert(1))").includes("<img"));
  // a picture written into the text (data:image) is already here: nothing is fetched to show it
  assert.ok(renderMarkdown("![x](data:image/png;base64,AAAA)").includes('<img class="md-img" src="data:image/png;base64,AAAA"'));
});
