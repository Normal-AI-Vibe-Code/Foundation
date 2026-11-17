/**
 * Search snippets (lib/snippet.ts): escaped, matches marked, and a match far
 * into a one-line snippet brought forward so the line's ellipsis can't hide it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { snippetHtml, snippetText } from "../src/lib/snippet.ts";

test("matches are marked and everything else is escaped", () => {
  assert.equal(snippetHtml("torque «spec» <b>&"), "torque <mark>spec</mark> &lt;b&gt;&amp;");
});

test("a match near the start stays where it is", () => {
  assert.equal(snippetHtml("the «intake» duct"), "the <mark>intake</mark> duct");
});

test("a match far in is brought forward, from a word, with a few words before it", () => {
  const s = "Page two of the assembly notes for the rear housing and the clamp bands: the «Osterlund» fan shroud is printed in PETG";
  const html = snippetHtml(s);
  assert.ok(html.startsWith("…"), html);
  assert.ok(html.indexOf("<mark>") < 40, html);
  assert.match(html, /^…\S/); // starts on a word, not mid-word or a space
  assert.ok(s.includes(html.slice(1, html.indexOf("<mark>")).replace(/ $/, "")), "nothing but the lead is cut");
});

test("plain text for a note made from a result", () => {
  assert.equal(snippetText("the «intake» duct"), "the intake duct");
});
