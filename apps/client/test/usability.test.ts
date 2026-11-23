/**
 * Usability & accessibility ratchet:
 * 1. Parses packages/ui/src/tokens.css directly and enforces WCAG 2.2 AA (>= 4.5:1)
 *    for every text, state and accent token against all 4 surfaces in Day and Night,
 *    plus --color-on-fill against every solid state/accent fill.
 * 2. Enforces focus-visible baseline, forced-colors preservation, accessible primitives,
 *    hover-capable gating, disabled press exclusion, root font smoothing and transition hygiene.
 * 3. Verifies Spring and Spring2D honor prefers-reduced-motion cleanly without breaking
 *    normal spring physics stepping.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Spring, Spring2D, prefersReducedMotion, presets } from "../src/physics/spring.ts";

const TOKENS_PATH = fileURLToPath(new URL("../../../packages/ui/src/tokens.css", import.meta.url));
const TOKENS_CSS = readFileSync(TOKENS_PATH, "utf8").replace(/\r\n/g, "\n");

const SURFACES = ["void", "abyss", "panel", "raise"] as const;
const FOREGROUNDS = ["frost", "mist", "dim", "moss", "pulse", "volt", "ok", "warn", "bad", "agent"] as const;
const SOLID_FILLS = ["pulse", "volt", "moss", "ok", "warn", "bad", "agent"] as const;

type ThemeTokens = Record<string, string>;

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function parseDayNightHexTokens(css: string): { day: ThemeTokens; night: ThemeTokens } {
  const clean = stripComments(css);
  // Extract the first :root, .f-day, .f-night, .f-paper declaration block
  const rootMatch = clean.match(/:root,\s*\.f-day,\s*\.f-night,\s*\.f-paper\s*\{([\s\S]*?)\}/);
  assert.ok(rootMatch, "expected primary token block in packages/ui/src/tokens.css");
  const block = rootMatch[1];

  const day: ThemeTokens = {};
  const night: ThemeTokens = {};

  // --color-<name>: color-mix(in srgb, #night calc(var(--night...) * 100%), #day);
  const mixRe = /--color-([a-z0-9-]+)\s*:\s*color-mix\(\s*in\s+srgb\s*,\s*(#[0-9a-fA-F]{3,6})\s+calc\(var\(--night(?:-hard)?\)\s*\*\s*100%\)\s*,\s*(#[0-9a-fA-F]{3,6})\s*\)\s*;/g;
  for (const m of block.matchAll(mixRe)) {
    const [, name, nightHex, dayHex] = m;
    night[name] = nightHex.toLowerCase();
    day[name] = dayHex.toLowerCase();
  }

  return { day, night };
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  assert.equal(full.length, 6, `expected 3- or 6-digit hex, got ${hex}`);
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const { day, night } = parseDayNightHexTokens(TOKENS_CSS);

test("tokens.css declares all surface, foreground, accent, and on-fill tokens", () => {
  for (const name of [...SURFACES, ...FOREGROUNDS, "on-fill"]) {
    assert.ok(day[name], `missing day --color-${name}`);
    assert.ok(night[name], `missing night --color-${name}`);
  }
});

test("WCAG 2.2 AA (>= 4.5:1): every text/state/accent token passes on all 4 surfaces in Day and Night", () => {
  const failures: string[] = [];
  for (const [modeName, palette] of [
    ["day", day],
    ["night", night],
  ] as const) {
    for (const fg of FOREGROUNDS) {
      for (const bg of SURFACES) {
        const ratio = contrastRatio(palette[fg], palette[bg]);
        if (ratio < 4.5) {
          failures.push(`${modeName}: --color-${fg} (${palette[fg]}) on --color-${bg} (${palette[bg]}) = ${ratio.toFixed(2)}:1 (< 4.5:1)`);
        }
      }
    }
  }
  assert.deepEqual(failures, [], `WCAG AA contrast failures:\n${failures.join("\n")}`);
});

test("WCAG 2.2 AA (>= 4.5:1): --color-on-fill passes on every solid state/accent fill in Day and Night", () => {
  const failures: string[] = [];
  for (const [modeName, palette] of [
    ["day", day],
    ["night", night],
  ] as const) {
    const onFill = palette["on-fill"];
    for (const fill of SOLID_FILLS) {
      const ratio = contrastRatio(onFill, palette[fill]);
      if (ratio < 4.5) {
        failures.push(`${modeName}: --color-on-fill (${onFill}) on --color-${fill} (${palette[fill]}) = ${ratio.toFixed(2)}:1 (< 4.5:1)`);
      }
    }
  }
  assert.deepEqual(failures, [], `WCAG AA on-fill contrast failures:\n${failures.join("\n")}`);
});

test("room theme --color-dim maintains legibility (>= 70% over-room mix)", () => {
  const clean = stripComments(TOKENS_CSS);
  const roomBlock = clean.match(/\.f-room,[\s\S]*?\{([\s\S]*?)\}/);
  assert.ok(roomBlock, "expected .f-room theme block in tokens.css");
  const dimMatch = roomBlock[1].match(/--color-dim\s*:\s*color-mix\(\s*in\s+srgb\s*,\s*var\(--color-over-room\)\s+(\d+)%/);
  assert.ok(dimMatch, "expected --color-dim color-mix in .f-room block");
  assert.ok(Number(dimMatch[1]) >= 70, `.f-room --color-dim mix is ${dimMatch[1]}%, expected >= 70%`);
});

test("tokens.css defines baseline :focus-visible ring, forced-colors preservation, and accessibility primitives", () => {
  const clean = stripComments(TOKENS_CSS);
  assert.match(clean, /:focus-visible\s*\{[^}]*outline\s*:\s*2px\s+solid\s+var\(--color-pulse\)[^}]*outline-offset\s*:\s*2px/s);
  for (const sel of ["button", "a", "input", "textarea", "select", "[tabindex]", '[role="button"]', '[role="tab"]', '[role="menuitem"]']) {
    assert.ok(clean.includes(sel), `expected ${sel} in :focus-visible baseline`);
  }
  assert.match(clean, /@media\s*\(\s*forced-colors\s*:\s*active\s*\)\s*\{[\s\S]*?outline\s*:\s*2px\s+solid\s+CanvasText/s);
  assert.match(clean, /\.f-sr-only\s*\{/);
  assert.match(clean, /\.f-skip-link\s*\{/);
  assert.match(clean, /\.f-skip-link:focus-visible\s*\{/);
  assert.match(clean, /--color-media-outline\s*:/);
  assert.match(clean, /-moz-osx-font-smoothing\s*:\s*grayscale/);
  assert.match(clean, /text-underline-position\s*:\s*from-font/);
});

test("tokens.css .f-pill excludes disabled press scaling, gates hover on (hover: hover), and removes tap highlight", () => {
  const clean = stripComments(TOKENS_CSS);
  assert.match(clean, /\.f-pill:not\(:disabled\):active\s*\{[^}]*transform\s*:\s*scale\(/s);
  assert.doesNotMatch(clean, /\.f-pill:active\b/, "bare .f-pill:active must not exist; use .f-pill:not(:disabled):active");
  assert.match(clean, /@media\s*\(\s*hover\s*:\s*hover\s*\)\s*\{[^}]*\.f-pill(?::not\(:disabled\))?:hover\s*\{/s);
  assert.match(clean, /\.f-pill\s*\{[^}]*-webkit-tap-highlight-color\s*:\s*transparent/s);
});

test("tokens.css never transitions background, color, or all", () => {
  const clean = stripComments(TOKENS_CSS);
  const transitions = [...clean.matchAll(/transition(?:-property)?\s*:\s*([^;]+);/g)].map((m) => m[1]);
  const bad = transitions.filter((val) =>
    val
      .split(/,(?![^(]*\))/)
      .flatMap((part) => part.trim().split(/\s+/))
      .some((word) => /^(background|background-color|color|all)$/.test(word)),
  );
  assert.deepEqual(bad, [], `disallowed transitions in tokens.css: ${bad.join("; ")}`);
});

function withReducedMotionMock<T>(matches: boolean, fn: () => T): T {
  const g = globalThis as unknown as {
    window?: { matchMedia?: (query: string) => { matches: boolean } };
    matchMedia?: (query: string) => { matches: boolean };
  };
  const hadWindow = Object.prototype.hasOwnProperty.call(g, "window");
  const prevWindow = g.window;
  const hadMM = Object.prototype.hasOwnProperty.call(g, "matchMedia");
  const prevMM = g.matchMedia;
  const mockMatchMedia = (query: string) => ({
    matches: query.includes("prefers-reduced-motion") && query.includes("reduce") ? matches : false,
  });
  g.window = { matchMedia: mockMatchMedia };
  try {
    return fn();
  } finally {
    if (hadWindow) g.window = prevWindow;
    else delete g.window;
    if (hadMM) g.matchMedia = prevMM;
    else delete g.matchMedia;
  }
}

test("prefersReducedMotion() is safe in Node without window/matchMedia", () => {
  assert.equal(prefersReducedMotion(), false);
});

test("Spring steps smoothly when reduced motion is not active", () => {
  withReducedMotionMock(false, () => {
    assert.equal(prefersReducedMotion(), false);
    const s = new Spring(0, presets.camera);
    const seen: number[] = [];
    s.onChange((v) => seen.push(v));

    s.to(100);
    assert.equal(s.goal, 100);
    assert.equal(s.restless, true);
    assert.equal(s.value, 0);

    s.step(1 / 60);
    assert.ok(s.value > 0 && s.value < 100, `expected intermediate spring value, got ${s.value}`);
    assert.ok(seen.length >= 1);

    for (let i = 0; i < 300 && s.restless; i++) s.step(1 / 60);
    assert.equal(s.value, 100);
    assert.equal(s.restless, false);
    // ensure no backup timer remains armed
    s.set(100);
  });
});

test("Spring and Spring2D settle synchronously to exact targets under prefers-reduced-motion: reduce", () => {
  withReducedMotionMock(true, () => {
    assert.equal(prefersReducedMotion(), true);

    const s = new Spring(10, presets.camera);
    const seen: number[] = [];
    s.onChange((v) => seen.push(v));

    s.to(240);
    assert.equal(s.value, 240);
    assert.equal(s.goal, 240);
    assert.equal(s.restless, false);
    assert.deepEqual(seen, [240]);

    const velocity = 900;
    const expectedProjected = 240 + velocity / (presets.camera.damping * 0.9);
    s.fling(velocity);
    assert.equal(s.value, expectedProjected);
    assert.equal(s.goal, expectedProjected);
    assert.equal(s.restless, false);
    assert.equal(seen[seen.length - 1], expectedProjected);

    const p = new Spring2D(0, 0, presets.drag);
    const coords: Array<[number, number]> = [];
    p.onChange((x, y) => coords.push([x, y]));

    p.to(120, -40);
    assert.equal(p.x.value, 120);
    assert.equal(p.y.value, -40);
    assert.equal(p.x.restless, false);
    assert.equal(p.y.restless, false);
    assert.deepEqual(coords[coords.length - 1], [120, -40]);

    const expectedX = 120 + 300 / (presets.drag.damping * 0.9);
    const expectedY = -40 + -150 / (presets.drag.damping * 0.9);
    p.fling(300, -150);
    assert.equal(p.x.value, expectedX);
    assert.equal(p.y.value, expectedY);
    assert.equal(p.x.restless, false);
    assert.equal(p.y.restless, false);
    assert.deepEqual(coords[coords.length - 1], [expectedX, expectedY]);
  });
});
