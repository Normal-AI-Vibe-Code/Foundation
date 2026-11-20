import { test } from "node:test";
import assert from "node:assert/strict";
import { TermTidy } from "../src/termtidy.ts";

/** run chunks through as one command and return everything shown */
function shown(...chunks: string[]) {
  const t = new TermTidy();
  let out = "";
  for (const c of chunks) out += t.push(c);
  const end = t.end();
  return { text: out + end.text, printed: end.printed };
}

test("a PowerShell table: the blank line before it and the two after it are dropped", () => {
  const r = shown("\r\nName  Length\r\n----  ------\r\na.txt     12\r\nb.txt      4\r\n\r\n\r\n");
  assert.equal(r.text, "Name  Length\r\n----  ------\r\na.txt     12\r\nb.txt      4\r\n");
  assert.equal(r.printed, true);
});

test("a run of blank lines inside the output becomes one", () => {
  const r = shown("first\n\n\n\nsecond\n\nthird\n");
  assert.equal(r.text, "first\r\n\r\nsecond\r\n\r\nthird\r\n");
});

test("a command that prints nothing, or only blank lines, shows nothing and says so", () => {
  assert.deepEqual(shown(), { text: "", printed: false });
  assert.deepEqual(shown("\r\n\r\n", "   \n"), { text: "", printed: false });
});

test("chunks split anywhere give the same result as one chunk", () => {
  const whole = "\n\nalpha beta\n\n\ngamma\n\n";
  const one = shown(whole).text;
  for (let cut = 1; cut < whole.length; cut++) {
    assert.equal(shown(whole.slice(0, cut), whole.slice(cut)).text, one, `cut at ${cut}`);
  }
  assert.equal(shown(...whole.split("")).text, one);
});

test("a line still being written is shown as it grows, and is closed when the command ends", () => {
  const t = new TermTidy();
  assert.equal(t.push("Continue? [y/n] "), "Continue? [y/n] ");
  assert.equal(t.push("still here"), "still here");
  assert.deepEqual(t.end(), { text: "\r\n", printed: true });
  // the next command starts clean
  assert.equal(t.push("\nnext\n"), "next\r\n");
});

test("indentation is kept; whitespace alone is not a line", () => {
  const r = shown("  indented\n", "    ", "\n", "\tmore\n");
  assert.equal(r.text, "  indented\r\n\r\n\tmore\r\n");
});
