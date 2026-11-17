/**
 * The design contract's ratchet (DESIGN.md §2, §9): components are drawn on
 * tokens only. Raw colours — hex, rgb(), rgba(), hsl() — belong in
 * packages/ui/src/tokens.css, where the tokens are made; anywhere else in the
 * client each one must be listed below with its reason, and the list may only
 * shrink. Component CSS also never transitions `background`/`color`: the night
 * engine animates every token for 1.4 s and a per-element transition lags it.
 *
 * Not scanned: tokens.css (packages/ui, outside the client), the sign-in's wind
 * (login/asciiWind2.js, Details' original), src-tauri and tests (outside src).
 * Mask gradients are exempt: a mask reads only alpha, never a colour.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const SKIP = new Set(["login/asciiWind2.js"]);

/**
 * Raw colours that stay, each with its reason. CSS entries name the rule's
 * selector and the property; script entries name a piece of the line. An entry
 * that no longer matches anything fails the test: take it out (the ratchet).
 */
const ALLOWED: Array<{ file: string; selector?: string; prop?: string; text?: string; why: string }> = [
  { file: "App.css", selector: ".link-chip.drive .link-ico", prop: "color", why: "Google Drive's own brand green on its glyph, not a state colour" },
  { file: "shell/shell.css", selector: ".search-tile-name", prop: "background", why: "dark scrim over a photo thumbnail: the photo doesn't change with night, so neither does its scrim" },
  { file: "shell/shell.css", selector: ".search-tile-name", prop: "color", why: "white caption on that fixed dark scrim" },
  { file: "shell/shell.css", selector: ".orb-sun", prop: "background", why: "the night orb's sun is artwork, the same in any room" },
  { file: "shell/shell.css", selector: ".orb-sun", prop: "box-shadow", why: "the sun's glow (artwork)" },
  { file: "shell/shell.css", selector: ".orb-moon", prop: "background", why: "the night orb's moon is artwork" },
  { file: "shell/shell.css", selector: ".orb-moon", prop: "box-shadow", why: "the moon's crescent shade (artwork)" },
  { file: "shell/shell.css", selector: ".live-frame iframe", prop: "background", why: "an embedded web page's canvas is white by the web's default, whatever our room" },
  { file: "cad/model.ts", text: "new THREE.Color(\"#c9cdd3\")", why: "three.js material default for a model with no colour; WebGL can't read a CSS token" },
  { file: "components/MapView.tsx", text: "\"background-color\": \"#e9e5dd\"", why: "MapLibre paint under the OSM tiles; MapLibre can't read a CSS token" },
  { file: "lib/huddle.ts", text: "|| \"#325bb4\"", why: "the dev fake camera's fallback when a token can't be read (day --color-pulse)" },
  { file: "login/Login.tsx", text: "#000 ${leave.radius}px", why: "the sign-in's dissolve is a mask: only alpha counts" },
];

/** every raw colour left in the client; may only go down */
const CEILING = 12;

const HEX = /(?<!url\()(?<![\w&])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;
const FN = /(?<![\w-])(?:rgba?|hsla?)\(/g;

interface Hit {
  file: string;
  line: number;
  selector?: string;
  prop?: string;
  text: string;
}

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

const files = walk(SRC)
  .map((f) => relative(SRC, f).split(sep).join("/"))
  .filter((f) => /\.(css|tsx?|jsx?)$/.test(f) && !/\.test\./.test(f) && !SKIP.has(f));
const css = files.filter((f) => f.endsWith(".css"));
const scripts = files.filter((f) => !f.endsWith(".css"));

/** blank out comments, keeping every newline so line numbers hold */
const blank = (m: string) => m.replace(/[^\n]/g, " ");
const stripCss = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, blank);
const stripScript = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(^|\s)\/\/.*$/gm, (m, pre: string) => pre + blank(m.slice(pre.length)));

const colours = (s: string) => [...s.matchAll(HEX), ...s.matchAll(FN)].map((m) => ({ at: m.index!, text: m[0] }));

/** each declaration in a stylesheet, with the selector of the rule it sits in */
function declarations(src: string) {
  const out: Array<{ selector: string; prop: string; value: string; at: number }> = [];
  const stack: string[] = [];
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") {
      stack.push(src.slice(start, i).trim().replace(/\s+/g, " "));
      start = i + 1;
    } else if (ch === ";" || ch === "}") {
      const body = src.slice(start, i);
      const colon = body.indexOf(":");
      const sel = stack[stack.length - 1];
      if (colon > 0 && sel !== undefined && !sel.startsWith("@")) {
        const lead = body.length - body.trimStart().length;
        out.push({ selector: sel, prop: body.slice(0, colon).trim(), value: body.slice(colon + 1), at: start + lead });
      }
      if (ch === "}") stack.pop();
      start = i + 1;
    }
  }
  return out;
}

const lineOf = (src: string, at: number) => src.slice(0, at).split("\n").length;

function scan(): { hits: Hit[]; transitions: string[] } {
  const hits: Hit[] = [];
  const transitions: string[] = [];
  for (const file of css) {
    const src = stripCss(readFileSync(join(SRC, file), "utf8").replace(/\r\n/g, "\n"));
    for (const d of declarations(src)) {
      const valueAt = src.indexOf(d.value, d.at);
      if (!/mask/.test(d.prop))
        for (const c of colours(d.value)) hits.push({ file, line: lineOf(src, valueAt + c.at), selector: d.selector, prop: d.prop, text: c.text });
      if (d.prop === "transition" || d.prop === "transition-property") {
        const named = d.value
          .split(/,(?![^(]*\))/)
          .flatMap((item) => item.trim().split(/\s+/))
          .filter((w) => /^(background|background-color|color|all)$/.test(w));
        if (named.length) transitions.push(`${file}:${lineOf(src, d.at)} ${d.selector} { transition: …${named.join(", ")}… }`);
      }
    }
  }
  for (const file of scripts) {
    const raw = readFileSync(join(SRC, file), "utf8").replace(/\r\n/g, "\n");
    const src = stripScript(raw);
    const lines = raw.split("\n");
    for (const c of colours(src)) {
      const line = lineOf(src, c.at);
      hits.push({ file, line, text: lines[line - 1].trim() });
    }
  }
  return { hits, transitions };
}

const allowedBy = (h: Hit) =>
  ALLOWED.find((a) => a.file === h.file && (a.text !== undefined ? h.text.includes(a.text) : a.selector === h.selector && a.prop === h.prop));

const { hits, transitions } = scan();

test("components use tokens: every raw colour left is listed with its reason", () => {
  const unlisted = hits.filter((h) => !allowedBy(h)).map((h) => `${h.file}:${h.line} ${h.selector ? `${h.selector} { ${h.prop}: ${h.text}… }` : h.text}`);
  assert.deepEqual(unlisted, [], "raw colours in components — mix a token instead (color-mix(in srgb, var(--color-…) N%, transparent)) or a --shadow-* token");
});

test("raw colours only go down (the ceiling)", () => {
  assert.ok(hits.length <= CEILING, `${hits.length} raw colours, ceiling ${CEILING}`);
  if (hits.length < CEILING) console.log(`# ${hits.length} raw colours left: lower CEILING in design.test.ts to ${hits.length}`);
});

test("the allowlist has no stale entries", () => {
  const stale = ALLOWED.filter((a) => !hits.some((h) => allowedBy(h) === a)).map((a) => `${a.file} ${a.selector ?? a.text}${a.prop ? ` ${a.prop}` : ""}`);
  assert.deepEqual(stale, [], "these raw colours are gone: take them off the list");
});

test("component CSS never transitions background or color (they lag the night fade)", () => {
  assert.deepEqual(transitions, []);
});
